import type {
  BacktestReport,
  BacktestTrade,
  CostConfig,
  MarketObservation,
  MarketSource,
  Position,
  RiskConfig,
  StrategyConfig,
} from '@spb/shared';
import {
  applyBuy,
  applySell,
  observationExitReferencePriceSol,
  poolFromObservation,
  simulateBuy,
  simulateSell,
  summarize,
  valuePosition,
  type AccountState,
} from '../paper/accounting';
import { evaluateEntry, evaluateExit } from '../strategy/momentumStrategy';
import { evaluateRisk } from '../risk/riskManager';
import { utcDayKey } from '../lib/util';

export interface Frame {
  ts: number;
  observations: Map<string, MarketObservation>;
}

export interface BacktestOptions {
  dataset: 'synthetic' | 'recorded';
  dataSource: string;
  strategy: StrategyConfig;
  risk: RiskConfig;
  costs: CostConfig;
  startingBalanceSol: number;
  /** For dataset 'recorded': which provider recorded the snapshots. */
  recordedSource?: MarketSource;
}

const ZERO_COSTS: CostConfig = { tradingFeeBps: 0, slippageBufferBps: 0, networkFeeSol: 0 };

interface Pending {
  mint: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  sizeSol?: number;
  fraction?: number;
  reason: string;
}

interface OpenTrade {
  entryAt: number;
  costSol: number;
  proceedsSol: number;
}

/**
 * Event-driven backtest that reuses the live strategy, risk and accounting code.
 *
 * Look-ahead protection: decisions at frame t only see frames <= t; the
 * resulting orders are filled against the pool state in frame t+1 (next-bar
 * execution). If the token is missing from frame t+1 the order is cancelled.
 */
export function runBacktest(frames: Frame[], o: BacktestOptions, costSensitivity = true): BacktestReport {
  const account: AccountState = {
    startingBalanceSol: o.startingBalanceSol,
    cashSol: o.startingBalanceSol,
    realizedPnlSol: 0,
    feesPaidSol: 0,
    peakEquitySol: o.startingBalanceSol,
    dayKey: frames.length ? utcDayKey(frames[0].ts) : '',
    dayStartEquitySol: o.startingBalanceSol,
    createdAt: frames[0]?.ts ?? 0,
  };
  const positions = new Map<string, Position>();
  const openTrades = new Map<string, OpenTrade>();
  const cooldowns = new Map<string, number>();
  const lastFill = new Map<string, number>();
  const trades: BacktestTrade[] = [];
  const curve: { ts: number; equity: number }[] = [];
  let pending: Pending[] = [];
  let rejected = 0;
  let cancelled = 0;
  let halted = false;
  let maxDd = 0;
  const exitReasons = new Map<string, string>();

  const closeTrade = (mint: string, symbol: string, ts: number) => {
    const t = openTrades.get(mint);
    if (!t) return;
    openTrades.delete(mint);
    const pnl = t.proceedsSol - t.costSol;
    trades.push({
      mint,
      symbol,
      entryAt: t.entryAt,
      exitAt: ts,
      costSol: t.costSol,
      proceedsSol: t.proceedsSol,
      pnlSol: pnl,
      returnPct: (pnl / t.costSol) * 100,
      exitReason: exitReasons.get(mint) ?? 'unknown',
    });
  };

  const summary = (ts: number, frame: Frame) =>
    summarize(
      account,
      // Use the same maxDataAgeMs as live paper so stale marks are classified consistently.
      [...positions.values()].map((p) => valuePosition(p, frame.observations.get(p.mint), ts, o.risk.maxDataAgeMs, o.costs)),
      ts,
    );

  const sell = (p: Position, obs: MarketObservation, fraction: number, ts: number): boolean => {
    const pool = poolFromObservation(obs);
    if (!pool.ok) return false;
    const qty = fraction >= 1 ? p.quantity : p.quantity * fraction;
    const sim = simulateSell(pool.pool, qty, o.costs);
    if (sim.netProceedsSol <= 0) return false;
    const applied = applySell(p, sim, ts);
    account.cashSol += sim.netProceedsSol;
    account.realizedPnlSol += applied.realizedPnlSol;
    account.feesPaidSol += sim.tradingFeeSol + sim.networkFeeSol;
    const t = openTrades.get(p.mint);
    if (t) t.proceedsSol += sim.netProceedsSol;
    if (applied.position) positions.set(p.mint, applied.position);
    else {
      positions.delete(p.mint);
      cooldowns.set(p.mint, ts);
      closeTrade(p.mint, p.symbol, ts);
    }
    lastFill.set(`${p.mint}:SELL`, ts);
    return true;
  };

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const ts = frame.ts;

    // 1. Fill orders decided on the previous frame against THIS frame's pool state.
    for (const ord of pending) {
      const obs = frame.observations.get(ord.mint);
      if (!obs) {
        cancelled++;
        continue;
      }
      const pool = poolFromObservation(obs);
      if (!pool.ok) {
        cancelled++;
        continue;
      }
      if (ord.side === 'SELL') {
        const p = positions.get(ord.mint);
        if (!p || !sell(p, obs, ord.fraction ?? 1, ts)) cancelled++;
        continue;
      }
      const sim = simulateBuy(pool.pool, ord.sizeSol ?? 0, o.costs);
      const held = positions.get(ord.mint);
      const r = evaluateRisk(
        { side: 'BUY', mint: ord.mint, sizeSol: ord.sizeSol, observation: obs },
        {
          now: ts,
          config: o.risk,
          killSwitchActive: halted,
          summary: summary(ts, frame),
          heldCostSol: held?.costBasisSol ?? 0,
          heldQuantity: held?.quantity ?? 0,
          lastExitAt: cooldowns.get(ord.mint) ?? null,
          lastSameSideFillAt: lastFill.get(`${ord.mint}:BUY`) ?? null,
          estimatedCostSol: sim.totalCostSol,
        },
      );
      if (!r.approved) {
        rejected++;
        continue;
      }
      positions.set(ord.mint, applyBuy(held, sim, { mint: ord.mint, symbol: ord.symbol, now: ts, liquiditySol: obs.quoteReserveSol }));
      account.cashSol -= sim.totalCostSol;
      account.feesPaidSol += sim.tradingFeeSol + sim.networkFeeSol;
      lastFill.set(`${ord.mint}:BUY`, ts);
      const t = openTrades.get(ord.mint) ?? { entryAt: ts, costSol: 0, proceedsSol: 0 };
      t.costSol += sim.totalCostSol;
      openTrades.set(ord.mint, t);
    }
    pending = [];

    // 2. Mark to market with data available at frame t.
    for (const [mint, p] of positions) {
      const obs = frame.observations.get(mint);
      const ref = obs ? observationExitReferencePriceSol(obs) : null;
      if (ref !== null) {
        positions.set(mint, { ...p, lastPriceSol: ref, lastPriceAt: ts, peakPriceSol: Math.max(p.peakPriceSol, ref) });
      }
    }
    let s = summary(ts, frame);
    const day = utcDayKey(ts);
    if (day !== account.dayKey) {
      account.dayKey = day;
      account.dayStartEquitySol = s.equitySol;
    }
    account.peakEquitySol = Math.max(account.peakEquitySol, s.equitySol);
    s = summary(ts, frame);
    maxDd = Math.max(maxDd, s.drawdownPct);
    curve.push({ ts, equity: s.equitySol });
    if (o.risk.autoKillOnDrawdown && s.drawdownPct >= o.risk.maxDrawdownPct) halted = true;

    if (i === frames.length - 1) break; // no next frame to fill decisions against

    // 3. Decide (exits first, then entries).
    for (const p of positions.values()) {
      const r = evaluateExit(p, frame.observations.get(p.mint), { now: ts, strategy: o.strategy, risk: o.risk, costs: o.costs });
      if (r.action === 'SELL') {
        exitReasons.set(p.mint, r.reasons[0]?.split(':')[0] ?? 'exit');
        pending.push({ mint: p.mint, symbol: p.symbol, side: 'SELL', fraction: r.fraction ?? 1, reason: r.reasons.join('; ') });
      }
    }
    if (!halted) {
      const candidates = [...frame.observations.values()]
        .filter((obs) => !positions.has(obs.mint))
        .sort((a, b) => (b.volume5mSol ?? -1) - (a.volume5mSol ?? -1));
      let slots = o.risk.maxConcurrentPositions - positions.size;
      for (const obs of candidates) {
        if (slots <= 0) break;
        const r = evaluateEntry(obs, {
          now: ts,
          strategy: o.strategy,
          risk: o.risk,
          costs: o.costs,
          held: false,
          lastExitAt: cooldowns.get(obs.mint) ?? null,
        });
        if (r.action === 'BUY') {
          pending.push({ mint: obs.mint, symbol: obs.symbol, side: 'BUY', sizeSol: r.sizeSol, reason: 'entry' });
          slots--;
        }
      }
    }
  }

  // End of data: liquidate remaining positions against the final frame they appear in.
  const last = frames[frames.length - 1];
  if (last) {
    for (const p of [...positions.values()]) {
      const obs = last.observations.get(p.mint);
      exitReasons.set(p.mint, 'end_of_backtest');
      if (!obs || !sell(p, obs, 1, last.ts)) {
        // Cannot model an exit: value at zero and record the full loss (conservative).
        positions.delete(p.mint);
        exitReasons.set(p.mint, 'end_of_backtest_unsellable');
        closeTrade(p.mint, p.symbol, last.ts);
      }
    }
    curve.push({ ts: last.ts, equity: account.cashSol });
  }

  const ending = account.cashSol;
  const wins = trades.filter((t) => t.pnlSol > 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = -trades.filter((t) => t.pnlSol < 0).reduce((a, t) => a + t.pnlSol, 0);
  // Recompute drawdown over the full curve, including the final liquidation point.
  let peak = -Infinity;
  for (const c of curve) {
    peak = Math.max(peak, c.equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - c.equity) / peak) * 100);
  }

  const step = Math.max(1, Math.ceil(curve.length / 500));
  return {
    dataset: o.dataset,
    dataSource: o.dataSource,
    disclaimer: disclaimerFor(o, frames),
    frames: frames.length,
    startTs: frames[0]?.ts ?? null,
    endTs: last?.ts ?? null,
    startingBalanceSol: o.startingBalanceSol,
    endingEquitySol: ending,
    netReturnPct: ((ending - o.startingBalanceSol) / o.startingBalanceSol) * 100,
    maxDrawdownPct: maxDd,
    tradeCount: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgTradeReturnPct: trades.length ? trades.reduce((a, t) => a + t.returnPct, 0) / trades.length : null,
    feesPaidSol: account.feesPaidSol,
    // Same frames and rules without fees/slippage buffer: isolates signal quality from cost drag.
    zeroCostNetReturnPct: costSensitivity ? runBacktest(frames, { ...o, costs: ZERO_COSTS }, false).netReturnPct : null,
    rejectedOrders: rejected,
    cancelledOrders: cancelled,
    trades,
    equityCurve: curve.filter((_, idx) => idx % step === 0 || idx === curve.length - 1),
    assumptions: [
      'Decisions at frame t use only data available at t; orders fill at frame t+1 (next-bar execution).',
      'Live paper bot signals use the same next-observation fill model (queued on the decision tick, filled after a newer observation).',
      'Fills use the constant-product AMM model on frame t+1 reserves, plus slippage buffer, trading fee and network fee.',
      'All-or-nothing fills; orders for tokens absent from the next frame are cancelled.',
      'Open positions are liquidated against the final frame; unsellable positions are written off at zero.',
      'Same strategy, risk and accounting code as the live paper engine.',
      'Position valuation uses risk.maxDataAgeMs (same stale classification as live paper).',
    ],
    limitations: [
      'The modelled pool reacts to our order but other traders do not react to it (no market impact feedback).',
      'No MEV, failed transactions, priority-fee auctions or latency variance are modelled.',
      'Synthetic data follows simple regime-switching random flow and is not calibrated to real pump.fun markets.',
      'Recorded data is sampled at the poll interval; intra-interval price paths are unknown.',
      'Profit factor is null when there are no losing trades; win rate is null with zero trades.',
    ],
  };
}

function disclaimerFor(o: BacktestOptions, frames: Frame[]): string {
  if (o.dataset === 'synthetic') {
    return 'SYNTHETIC DATA from the mock simulator. These results say nothing about real-world profitability.';
  }
  const hours = frames.length > 1 ? (frames[frames.length - 1].ts - frames[0].ts) / 3_600_000 : 0;
  if (o.recordedSource === 'dexscreener') {
    return (
      `RECORDED REAL MARKET SNAPSHOTS (DexScreener, read-only) spanning ${hours.toFixed(1)} h, replayed offline. ` +
      'Fills are modelled, never executed. A short, single-period sample is not evidence of real-world profitability.'
    );
  }
  return `RECORDED MOCK (synthetic) observations spanning ${hours.toFixed(1)} h. These say nothing about real-world profitability.`;
}
