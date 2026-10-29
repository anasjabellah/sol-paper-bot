import { sourceOfMint, type Check, type OrderOrigin, type OrderType, type PaperOrder, type Side } from '@spb/shared';
import type { Repository } from '../database/repository';
import type { AuditLogger } from '../logging/audit';
import type { MarketDataService } from '../market/marketService';
import {
  EXECUTION_MODEL,
  applyBuy,
  applySell,
  poolFromObservation,
  simulateBuy,
  simulateSell,
  type BuySimulation,
  type SellSimulation,
} from '../paper/accounting';
import { evaluateRisk } from '../risk/riskManager';
import { HttpError } from '../lib/errors';
import { newId, type Clock } from '../lib/util';
import type { PortfolioService } from './portfolioService';
import type { SettingsService } from './settingsService';

export interface OrderSubmission {
  clientOrderId: string;
  mint: string;
  side: Side;
  type: OrderType;
  origin: OrderOrigin;
  /** BUY only */
  sizeSol?: number;
  /** SELL only: fraction of open position (0, 1] */
  fraction?: number;
  limitPriceSol?: number;
}

export interface OrderResult {
  order: PaperOrder;
  /** True when the clientOrderId was already processed and the stored result is returned. */
  replay: boolean;
}

const fingerprint = (o: { mint: string; side: Side; type: OrderType; requested: PaperOrder['requested'] }) =>
  JSON.stringify([o.mint, o.side, o.type, o.requested.sizeSol ?? null, o.requested.fraction ?? null, o.requested.limitPriceSol ?? null]);

/**
 * The ONLY place simulated orders are executed. There is deliberately no code
 * path here (or anywhere in the repo) that builds, signs or sends a Solana transaction.
 */
export class OrderService {
  constructor(
    private readonly repo: Repository,
    private readonly market: MarketDataService,
    private readonly portfolio: PortfolioService,
    private readonly settings: SettingsService,
    private readonly audit: AuditLogger,
    private readonly clock: Clock,
  ) {}

  submit(req: OrderSubmission): Promise<OrderResult> {
    // Serialize: idempotency, risk checks and accounting see a consistent state.
    return this.portfolio.lock.run(() => this.execute(req));
  }

  private async execute(req: OrderSubmission): Promise<OrderResult> {
    const now = this.clock();
    const requested: PaperOrder['requested'] =
      req.side === 'BUY' ? { sizeSol: req.sizeSol } : { fraction: req.fraction };
    if (req.limitPriceSol !== undefined) requested.limitPriceSol = req.limitPriceSol;

    // 1. Idempotency
    const existing = await this.repo.getOrderByClientId(req.clientOrderId);
    if (existing) {
      if (fingerprint(existing) !== fingerprint({ ...req, requested })) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'clientOrderId was already used for a different order', {
          existingOrderId: existing.id,
        });
      }
      return { order: existing, replay: true };
    }

    // 2. Gather state
    const obs = this.market.get(req.mint);
    const snap = await this.portfolio.snapshot();
    const position = snap.positions.find((p) => p.mint === req.mint);
    const cooldowns = await this.portfolio.cooldowns();
    const costs = this.portfolio.costs;
    const extraChecks: Check[] = [];

    // 3. Model the fill (only if we can justify a price)
    let buySim: BuySimulation | undefined;
    let sellSim: SellSimulation | undefined;
    let sellQty: number | undefined;
    if (!obs) {
      extraChecks.push({ name: 'execution_model', passed: false, detail: 'no market observation for this token' });
    } else {
      const pool = poolFromObservation(obs);
      if (!pool.ok) extraChecks.push({ name: 'execution_model', passed: false, detail: pool.reason });
      else {
        extraChecks.push({ name: 'execution_model', passed: true, detail: EXECUTION_MODEL });
        if (req.side === 'BUY' && req.sizeSol && req.sizeSol > 0) buySim = simulateBuy(pool.pool, req.sizeSol, costs);
        if (req.side === 'SELL' && position && req.fraction && req.fraction > 0) {
          sellQty = req.fraction >= 1 ? position.quantity : position.quantity * req.fraction;
          sellSim = simulateSell(pool.pool, sellQty, costs);
          extraChecks.push({
            name: 'positive_proceeds',
            passed: sellSim.netProceedsSol > 0,
            detail: `net proceeds ${sellSim.netProceedsSol.toFixed(9)} SOL`,
          });
        }
      }
    }
    if (req.type === 'LIMIT' && req.limitPriceSol !== undefined) {
      const px = buySim?.priceSol ?? sellSim?.priceSol;
      if (px === undefined) extraChecks.push({ name: 'limit_price', passed: false, detail: 'no modelled execution price' });
      else {
        const ok = req.side === 'BUY' ? px <= req.limitPriceSol : px >= req.limitPriceSol;
        extraChecks.push({
          name: 'limit_price',
          passed: ok,
          detail: `modelled price ${px.toExponential(6)} vs limit ${req.limitPriceSol.toExponential(6)} (immediate-or-cancel)`,
        });
      }
    }

    // 4. Risk gate
    const risk = evaluateRisk(
      { side: req.side, mint: req.mint, sizeSol: req.sizeSol, quantity: sellQty, observation: obs },
      {
        now,
        config: this.settings.getRisk(),
        killSwitchActive: this.settings.getKillSwitch().active,
        summary: snap.summary,
        heldCostSol: position?.costBasisSol ?? 0,
        heldQuantity: position?.quantity ?? 0,
        lastExitAt: cooldowns[req.mint] ?? null,
        lastSameSideFillAt: await this.repo.lastFilledAt(req.mint, req.side),
        estimatedCostSol: buySim?.totalCostSol,
      },
    );
    const checks = [...risk.checks, ...extraChecks];
    const failed = checks.filter((c) => !c.passed);

    const base: PaperOrder = {
      id: newId(now),
      clientOrderId: req.clientOrderId,
      mint: req.mint,
      symbol: obs?.symbol ?? position?.symbol ?? '?',
      side: req.side,
      type: req.type,
      origin: req.origin,
      status: 'REJECTED',
      requested,
      createdAt: now,
      rejectReason: null,
      riskChecks: checks,
      fill: null,
      simulated: true,
      marketDataSource: obs?.source ?? sourceOfMint(req.mint),
    };

    if (failed.length > 0 || !obs || (req.side === 'BUY' ? !buySim : !sellSim || !position)) {
      const order: PaperOrder = {
        ...base,
        rejectReason: failed.map((c) => `${c.name}: ${c.detail}`).join('; ') || 'order could not be simulated',
      };
      await this.repo.insertOrder(order);
      await this.audit.warn('order.rejected', `Simulated ${req.side} ${order.symbol} rejected`, {
        orderId: order.id,
        clientOrderId: order.clientOrderId,
        origin: req.origin,
        reason: order.rejectReason,
      });
      return { order, replay: false };
    }

    // 5. Apply atomically
    const order = await this.repo.db.transaction(async (tx) => {
      const account = await this.portfolio.getAccount(tx);
      let filled: PaperOrder;
      if (req.side === 'BUY' && buySim) {
        const next = applyBuy(position, buySim, { mint: req.mint, symbol: base.symbol, now, liquiditySol: obs.quoteReserveSol });
        account.cashSol -= buySim.totalCostSol;
        account.feesPaidSol += buySim.tradingFeeSol + buySim.networkFeeSol;
        await this.repo.upsertPosition(next, tx);
        filled = {
          ...base,
          status: 'FILLED',
          fill: {
            quantity: buySim.quantity,
            priceSol: buySim.priceSol,
            spotPriceSol: buySim.spotPriceSol,
            grossSol: buySim.grossSol,
            tradingFeeSol: buySim.tradingFeeSol,
            networkFeeSol: buySim.networkFeeSol,
            priceImpactPct: buySim.priceImpactPct,
            cashDeltaSol: -buySim.totalCostSol,
            realizedPnlSol: null,
            costBasisReleasedSol: null,
            observationAt: obs.observedAt,
            model: EXECUTION_MODEL,
            quotedPriceSol: obs.priceSol ?? undefined,
            exitReferencePriceSol: buySim.exitReferencePriceSol,
          },
        };
      } else if (sellSim && position) {
        const applied = applySell(position, sellSim, now);
        account.cashSol += sellSim.netProceedsSol;
        account.realizedPnlSol += applied.realizedPnlSol;
        account.feesPaidSol += sellSim.tradingFeeSol + sellSim.networkFeeSol;
        if (applied.position) await this.repo.upsertPosition(applied.position, tx);
        else {
          await this.repo.deletePosition(req.mint, tx);
          cooldowns[req.mint] = now;
          await this.repo.setKv('cooldowns', cooldowns, tx);
        }
        filled = {
          ...base,
          status: 'FILLED',
          fill: {
            quantity: sellSim.quantity,
            priceSol: sellSim.priceSol,
            spotPriceSol: sellSim.spotPriceSol,
            grossSol: sellSim.grossSol,
            tradingFeeSol: sellSim.tradingFeeSol,
            networkFeeSol: sellSim.networkFeeSol,
            priceImpactPct: sellSim.priceImpactPct,
            cashDeltaSol: sellSim.netProceedsSol,
            realizedPnlSol: applied.realizedPnlSol,
            costBasisReleasedSol: applied.costBasisReleasedSol,
            observationAt: obs.observedAt,
            model: EXECUTION_MODEL,
            quotedPriceSol: obs.priceSol ?? undefined,
            exitReferencePriceSol: sellSim.exitReferencePriceSol,
          },
        };
      } else {
        throw new Error('unreachable: no simulation for approved order');
      }
      // Invariant: the virtual account can never go negative.
      if (account.cashSol < -1e-9) throw new Error('invariant violated: virtual cash would become negative');
      await this.repo.setKv('account', account, tx);
      await this.repo.insertOrder(filled, tx);
      await this.audit.info(
        'order.filled',
        `Simulated ${filled.side} ${filled.symbol} filled (virtual)`,
        { orderId: filled.id, clientOrderId: filled.clientOrderId, origin: req.origin, fill: filled.fill },
        tx,
      );
      return filled;
    });
    return { order, replay: false };
  }

  /** Reset the paper account (requires the bot to be stopped - enforced by caller). */
  reset(startingBalanceSol: number): Promise<void> {
    return this.portfolio.lock.run(async () => {
      await this.repo.db.transaction(async (tx) => {
        await this.repo.resetTradingState(tx);
        await this.portfolio.createAccount(startingBalanceSol, tx);
      });
      await this.audit.warn('portfolio.reset', `Paper account reset to ${startingBalanceSol} virtual SOL`);
    });
  }
}
