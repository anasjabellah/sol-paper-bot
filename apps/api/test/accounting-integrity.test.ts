import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuditEntry, BotStatus, MarketObservation, PaperOrder, PortfolioSummary, PositionView } from '@spb/shared';
import { applyBuy, poolFromObservation, simulateBuy, summarize, valuePosition, type AccountState } from '../src/paper/accounting';
import { ManualClock, StaticProvider, makeApp, makeObs } from './helpers';

/** Deterministic fixtures only; all databases are in-memory. */
const costs = { tradingFeeBps: 100, slippageBufferBps: 50, networkFeeSol: 0.000105 };
const NOW = Date.UTC(2026, 5, 1, 12);
const MINT = 'mock_0001aaa';
const gapObs = (now: number, implied: number, quoted: number, q = 200): MarketObservation =>
  makeObs(now, { priceSol: quoted, quoteReserveSol: q, baseReserve: q / implied });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('B4: valuation never uses a non-executable quote as a live value', () => {
  const entry = poolFromObservation(gapObs(NOW, 1e-6, 1e-6));
  if (!entry.ok) throw new Error(entry.reason);
  const pos = applyBuy(undefined, simulateBuy(entry.pool, 0.25, costs), { mint: MINT, symbol: 'SIM', now: NOW, liquiditySol: 200 });

  it('a fresh observation whose pool cannot be modelled is valued at the last exit reference, flagged stale', () => {
    // Quote jumps 40% while reserves are missing: no SELL could be modelled.
    const unusable = makeObs(NOW + 10_000, { priceSol: 1.4e-6, quoteReserveSol: null, baseReserve: null });
    const v = valuePosition(pos, unusable, NOW + 10_000, 30_000, costs);
    expect(v.valuationMethod).toBe('last-known-price');
    expect(v.priceStale).toBe(true);
    expect(v.markPriceSol).toBe(pos.lastPriceSol); // not the 1.4e-6 quote
    const expected = pos.lastPriceSol * pos.quantity * (1 - 0.005) * (1 - 0.01) - 0.000105;
    expect(v.liquidationValueSol).toBeCloseTo(expected, 15);
  });

  it('a quote/pool gap beyond tolerance is treated the same way (no optimistic quoted mark)', () => {
    const tooWide = gapObs(NOW + 10_000, 1e-6, 1.3e-6); // 30% gap
    expect(poolFromObservation(tooWide).ok).toBe(false);
    const v = valuePosition(pos, tooWide, NOW + 10_000, 30_000, costs);
    expect(v.valuationMethod).toBe('last-known-price');
    expect(v.priceStale).toBe(true);
    expect(v.liquidationValueSol).toBeLessThan(pos.quantity * 1.3e-6);
  });

  it('such a position is excluded from live unrealized P&L but kept in equity', () => {
    const account: AccountState = { startingBalanceSol: 10, cashSol: 10 - pos.costBasisSol, realizedPnlSol: 0, feesPaidSol: 0, peakEquitySol: 10, dayKey: 'd', dayStartEquitySol: 10, createdAt: NOW };
    const v = valuePosition(pos, makeObs(NOW, { priceSol: 1.4e-6, quoteReserveSol: null, baseReserve: null }), NOW, 30_000, costs);
    const s = summarize(account, [v], NOW);
    expect(s.unrealizedPnlSol).toBe(0);
    expect(s.stalePositions).toBe(1);
    expect(s.equitySol).toBeCloseTo(account.cashSol + v.liquidationValueSol, 15);
  });
});

describe('fill records are self-describing for audits', () => {
  it('stores the quoted price and exit reference used for every simulated fill', async () => {
    const clock = new ManualClock(NOW);
    const provider = new StaticProvider();
    provider.observations = [gapObs(clock.now(), 1e-6, 1.01e-6)];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.market.refresh(true);
    const r = await app.inject({ method: 'POST', url: '/api/orders', payload: { mode: 'PAPER', clientOrderId: 'audit-0001', mint: MINT, side: 'BUY', sizeSol: 0.25 } });
    const fill = (r.json().order as PaperOrder).fill!;
    expect(fill.quotedPriceSol).toBe(1.01e-6);
    expect(fill.exitReferencePriceSol).toBe(1e-6);
    expect(fill.spotPriceSol).toBeCloseTo(1e-6, 18);
  });
});

describe('fees, balances and sizing over a deterministic multi-trade sequence', () => {
  it('cash, fees, realized P&L, cost basis and equity reconcile exactly', async () => {
    const clock = new ManualClock(NOW);
    const provider = new StaticProvider();
    ({ app } = await makeApp({ clock, provider }));
    await app.services.settings.updateRisk({ duplicateWindowMs: 0, maxExposurePerTokenSol: 2, cooldownMinutesAfterExit: 0 });
    const step = async (implied: number, quoted: number, order: Record<string, unknown>) => {
      clock.advance(10_000);
      provider.observations = [gapObs(clock.now(), implied, quoted)];
      await app!.services.market.refresh(true);
      const r = await app!.inject({ method: 'POST', url: '/api/orders', payload: { mode: 'PAPER', clientOrderId: `seq-${clock.now()}`, mint: MINT, ...order } });
      expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
      return r.json().order as PaperOrder;
    };
    const o1 = await step(1e-6, 1e-6, { side: 'BUY', sizeSol: 0.3 });
    const o2 = await step(1.05e-6, 1.06e-6, { side: 'BUY', sizeSol: 0.2 }); // add, quote above pool
    const o3 = await step(1.1e-6, 1.09e-6, { side: 'SELL', fraction: 0.4 }); // partial, quote below pool
    const o4 = await step(0.95e-6, 0.95e-6, { side: 'SELL', fraction: 1 }); // close
    const fills = [o1, o2, o3, o4].map((o) => o.fill!);

    // Buy debit = size + 1% fee + network fee, exactly.
    expect(-fills[0].cashDeltaSol).toBeCloseTo(0.3 * 1.01 + 0.000105, 15);
    expect(-fills[1].cashDeltaSol).toBeCloseTo(0.2 * 1.01 + 0.000105, 15);
    // Sell credit = gross - 1% fee - network fee, exactly.
    for (const f of fills.slice(2)) expect(f.cashDeltaSol).toBeCloseTo(f.grossSol * 0.99 - 0.000105, 15);
    // Partial sell releases 40% of the cost basis; the close releases the rest.
    const totalCost = -fills[0].cashDeltaSol - fills[1].cashDeltaSol;
    expect(fills[2].costBasisReleasedSol).toBeCloseTo(totalCost * 0.4, 12);
    expect(fills[2].costBasisReleasedSol! + fills[3].costBasisReleasedSol!).toBeCloseTo(totalCost, 12);

    const s = (await app.inject({ method: 'GET', url: '/api/portfolio' })).json() as PortfolioSummary;
    expect(s.openPositions).toBe(0);
    expect(s.cashSol).toBeCloseTo(10 + fills.reduce((a, f) => a + f.cashDeltaSol, 0), 12);
    expect(s.feesPaidSol).toBeCloseTo(fills.reduce((a, f) => a + f.tradingFeeSol + f.networkFeeSol, 0), 12);
    expect(s.realizedPnlSol).toBeCloseTo(fills[2].realizedPnlSol! + fills[3].realizedPnlSol!, 12);
    // With everything closed, total P&L equals realized P&L (fees inside both legs, counted once).
    expect(s.equitySol).toBeCloseTo(s.cashSol, 12);
    expect(s.totalPnlSol).toBeCloseTo(s.realizedPnlSol, 12);
  });

  it('exposure limit includes fees (size + fee + network vs max exposure)', async () => {
    const clock = new ManualClock(NOW);
    const provider = new StaticProvider();
    provider.observations = [gapObs(clock.now(), 1e-6, 1e-6)];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.settings.updateRisk({ maxOrderSizeSol: 2, maxExposurePerTokenSol: 1 });
    await app.services.market.refresh(true);
    // 0.99 SOL + 1% fee + network fee = 1.000005 SOL > 1 SOL limit
    const r = await app.inject({ method: 'POST', url: '/api/orders', payload: { mode: 'PAPER', clientOrderId: 'expo-0001', mint: MINT, side: 'BUY', sizeSol: 0.99 } });
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/max_exposure_per_token: 1\.0000 SOL after order/);
    const views = (await app.inject({ method: 'GET', url: '/api/portfolio/positions' })).json().items as PositionView[];
    expect(views).toHaveLength(0);
  });
});

describe('monitoring gaps are recorded, not hidden', () => {
  it('a long pause between ticks is audited with the number of unwatched positions', async () => {
    const clock = new ManualClock(NOW);
    const provider = new StaticProvider();
    provider.observations = [gapObs(clock.now(), 1e-6, 1e-6)];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.market.refresh(true);
    await app.inject({ method: 'POST', url: '/api/orders', payload: { mode: 'PAPER', clientOrderId: 'gap-buy-0001', mint: MINT, side: 'BUY', sizeSol: 0.25 } });
    await app.services.bot.tick();
    clock.advance(5_000);
    await app.services.bot.tick(); // normal cadence: no gap
    clock.advance(45 * 60_000); // e.g. machine asleep
    await app.services.bot.tick();

    const status = (await app.inject({ method: 'GET', url: '/api/status' })).json().bot as BotStatus;
    expect(status.monitoringGaps).toHaveLength(1);
    expect(status.monitoringGaps[0]).toMatchObject({ openPositions: 1, botRunning: false });
    expect(status.monitoringGaps[0].to - status.monitoringGaps[0].from).toBe(45 * 60_000);
    const audit = (await app.inject({ method: 'GET', url: '/api/logs/audit?level=warn&limit=50' })).json().items as AuditEntry[];
    const gaps = audit.filter((a) => a.type === 'bot.monitoring_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].message).toMatch(/No monitoring for 45 min \(1 open position\(s\) unwatched/);
  });
});
