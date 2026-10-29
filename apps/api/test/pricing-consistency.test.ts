import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, type CostConfig, type MarketObservation, type PaperOrder, type PortfolioSummary, type PositionView, type StrategyDecision } from '@spb/shared';
import {
  applyBuy,
  applySell,
  estimateEntryCost,
  estimateExit,
  exitReferencePriceSol,
  poolFromObservation,
  simulateBuy,
  simulateSell,
  valuePosition,
  type PoolSnapshot,
} from '../src/paper/accounting';
import { evaluateEntry, evaluateExit } from '../src/strategy/momentumStrategy';
import { ManualClock, StaticProvider, makeApp, makeObs } from './helpers';

/**
 * Regression tests for the price-consistency fixes (audit B1-B3). All fixtures are deterministic.
 * Convention: buy anchor = max(quoted, implied); exit reference = min(quoted, implied).
 */
const costs: CostConfig = { tradingFeeBps: 100, slippageBufferBps: 50, networkFeeSol: 0.000105 };
const NOW = Date.UTC(2026, 5, 1, 12);
const Q = 200; // SOL in pool

/** Observation whose pool implies `implied` while the source quotes `quoted`. */
function gapObs(now: number, implied: number, quoted: number, overrides: Partial<MarketObservation> = {}): MarketObservation {
  return makeObs(now, { priceSol: quoted, quoteReserveSol: Q, baseReserve: Q / implied, ...overrides });
}
const pool = (o: MarketObservation): PoolSnapshot => {
  const p = poolFromObservation(o);
  if (!p.ok) throw new Error(p.reason);
  return p.pool;
};
const entryCtx = { now: NOW, strategy: DEFAULT_STRATEGY_CONFIG, risk: DEFAULT_RISK_CONFIG, costs, held: false, lastExitAt: null };
const exitCtx = { now: NOW, strategy: DEFAULT_STRATEGY_CONFIG, risk: DEFAULT_RISK_CONFIG, costs };
const impactCheck = (o: MarketObservation) => evaluateEntry(o, entryCtx).checks.find((c) => c.name === 'max_price_impact')!;

describe('B2: entry cost counts the quote/pool gap symmetrically', () => {
  it('quote ABOVE pool-implied: buy is anchored to the quote, gap counted', () => {
    const o = gapObs(NOW, 1e-6, 1.05e-6);
    const p = pool(o);
    const est = estimateEntryCost(p, 0.25, costs);
    expect(exitReferencePriceSol(p)).toBe(1e-6);
    expect(est.gapPct).toBeCloseTo(5, 9);
    expect(est.buy.priceSol).toBeGreaterThan(1.05e-6); // never cheaper than the quote
    expect(est.totalPct).toBeCloseTo((est.buy.priceSol / 1e-6 - 1) * 100, 9);
    expect(impactCheck(o).passed).toBe(false); // > 3% default
    expect(impactCheck(o).detail).toMatch(/quote\/pool gap 5\.00%/);
  });

  it('quote BELOW pool-implied: buy is anchored to the pool, and the same gap is counted (was missed before)', () => {
    const o = gapObs(NOW, 1e-6, 0.95e-6);
    const p = pool(o);
    const est = estimateEntryCost(p, 0.25, costs);
    expect(exitReferencePriceSol(p)).toBe(0.95e-6);
    expect(est.gapPct).toBeCloseTo((1 / 0.95 - 1) * 100, 9);
    expect(est.buy.priceSol).toBeGreaterThan(1e-6); // filled above the visible quote
    expect(est.totalPct).toBeGreaterThan(5.26);
    expect(impactCheck(o).passed).toBe(false);
  });

  it('the strategy estimate equals what the simulated BUY realises (decision and fill cannot disagree)', () => {
    for (const quoted of [0.99e-6, 1e-6, 1.01e-6]) {
      const o = gapObs(NOW, 1e-6, quoted);
      const est = estimateEntryCost(pool(o), DEFAULT_STRATEGY_CONFIG.orderSizeSol, costs);
      const fill = simulateBuy(pool(o), DEFAULT_STRATEGY_CONFIG.orderSizeSol, costs);
      expect(est.buy.priceSol).toBe(fill.priceSol);
      const detail = impactCheck(o).detail;
      expect(detail).toContain(`est. ${est.totalPct.toFixed(2)}%`);
      expect(impactCheck(o).passed).toBe(est.totalPct <= DEFAULT_STRATEGY_CONFIG.maxPriceImpactPct);
    }
  });

  it('small symmetric gaps on either side pass or fail identically', () => {
    const above = estimateEntryCost(pool(gapObs(NOW, 1e-6, 1.01e-6)), 0.25, costs);
    const below = estimateEntryCost(pool(gapObs(NOW, 1.01e-6, 1e-6)), 0.25, costs);
    expect(above.gapPct).toBeCloseTo(below.gapPct, 9);
  });
});

describe('B1: exit decisions use the executable SELL estimate', () => {
  // Bought 0.25 SOL on a gap-free pool at 1e-6.
  const entryPool = pool(gapObs(NOW, 1e-6, 1e-6));
  const buy = simulateBuy(entryPool, 0.25, costs);
  const position = applyBuy(undefined, buy, { mint: 'mock_0001aaa', symbol: 'SIM', now: NOW - 60_000, liquiditySol: Q });

  it('stop-loss fires on the executable estimate even when the quote alone would not trigger it', () => {
    // Quote down 8% (old quote-based P&L ~ -9.5%: no stop), but the pool implies -14%.
    const o = gapObs(NOW, 0.86e-6, 0.92e-6);
    const quotedPnl = ((0.92e-6 - position.avgEntryPriceSol) / position.avgEntryPriceSol) * 100;
    expect(quotedPnl).toBeGreaterThan(-12);
    const r = evaluateExit(position, o, exitCtx);
    expect(r.action).toBe('SELL');
    expect(r.reasons[0]).toMatch(/^stop_loss/);
    const est = estimateExit(position, pool(o), costs);
    expect(est.netPnlPct).toBeLessThanOrEqual(-12);
  });

  it('take-profit requires the target net of exit costs (quote-only +25% is not enough)', () => {
    // Quote +28% but pool-implied only +24%: executable net P&L < 25% -> hold.
    const notYet = gapObs(NOW, 1.24e-6, 1.28e-6);
    const quotedPnl = ((1.28e-6 - position.avgEntryPriceSol) / position.avgEntryPriceSol) * 100;
    expect(quotedPnl).toBeGreaterThan(25);
    expect(evaluateExit(position, notYet, exitCtx).action).toBe('SKIP');
    // Pool and quote both well above target -> take profit.
    const r = evaluateExit(position, gapObs(NOW, 1.35e-6, 1.36e-6), exitCtx);
    expect(r.action).toBe('SELL');
    expect(r.reasons[0]).toMatch(/^take_profit/);
  });

  it('decision P&L equals the valuation unrealized P&L and the realized P&L of a SELL on the same observation', () => {
    const o = gapObs(NOW, 0.9e-6, 0.93e-6);
    const p = pool(o);
    const est = estimateExit(position, p, costs);
    const view = valuePosition(position, o, NOW, DEFAULT_RISK_CONFIG.maxDataAgeMs, costs);
    expect(est.netPnlPct).toBeCloseTo(view.unrealizedPnlPct, 12);
    const sold = applySell(position, simulateSell(p, position.quantity, costs), NOW);
    expect(sold.realizedPnlSol).toBeCloseTo(est.netProceedsSol - position.costBasisSol, 15);
  });
});

describe('fees, slippage and impact are counted exactly once', () => {
  it('round trip on an unchanged gap-free pool loses exactly entry + exit costs', () => {
    const p = pool(gapObs(NOW, 1e-6, 1e-6));
    const buy = simulateBuy(p, 0.25, costs);
    const pos = applyBuy(undefined, buy, { mint: 'm', symbol: 'M', now: NOW, liquiditySol: Q });
    // Pool after our buy (constant product), quote follows the pool.
    const q2 = Q + 0.25;
    const b2 = (Q * (Q / 1e-6)) / q2;
    const after = pool(makeObs(NOW, { priceSol: q2 / b2, quoteReserveSol: q2, baseReserve: b2 }));
    const est = estimateExit(pos, after, costs);
    const sell = simulateSell(after, pos.quantity, costs);
    // Exit estimate is exactly the simulated SELL - no extra haircut applied anywhere.
    expect(est.netProceedsSol).toBe(sell.netProceedsSol);
    // Manually recompute: buffer applied once per side, fee once per side, network fee once per side.
    const buf = 1 - costs.slippageBufferBps / 10_000;
    const tokens = ((Q / 1e-6) * 0.25) / (Q + 0.25) * buf;
    expect(pos.quantity).toBeCloseTo(tokens, 6);
    const grossOut = ((q2 * tokens) / (b2 + tokens)) * buf;
    const expectedNet = grossOut * (1 - costs.tradingFeeBps / 10_000) - costs.networkFeeSol;
    expect(est.netProceedsSol).toBeCloseTo(expectedNet, 12);
    expect(pos.costBasisSol).toBeCloseTo(0.25 * (1 + costs.tradingFeeBps / 10_000) + costs.networkFeeSol, 15);
  });
});

describe('B3: last/peak price and trailing stop use one basis', () => {
  it('entry initialises last and peak price to the exit reference (min of quote and pool)', () => {
    for (const [implied, quoted] of [
      [1e-6, 1.01e-6],
      [1.01e-6, 1e-6],
    ]) {
      const p = pool(gapObs(NOW, implied, quoted));
      const pos = applyBuy(undefined, simulateBuy(p, 0.25, costs), { mint: 'm', symbol: 'M', now: NOW, liquiditySol: Q });
      expect(pos.lastPriceSol).toBe(Math.min(implied, quoted));
      expect(pos.peakPriceSol).toBe(Math.min(implied, quoted));
    }
  });

  it('a quote spike alone (pool unchanged) does not raise the trailing-stop peak', async () => {
    const clock = new ManualClock(NOW);
    const provider = new StaticProvider();
    provider.observations = [gapObs(clock.now(), 1e-6, 1e-6)];
    const { app } = await makeApp({ clock, provider });
    try {
      await app.services.market.refresh(true);
      await app.inject({ method: 'POST', url: '/api/orders', payload: { mode: 'PAPER', clientOrderId: 'trail-0001', mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.25 } });
      clock.advance(10_000);
      provider.observations = [gapObs(clock.now(), 1e-6, 1.1e-6)]; // quote +10%, pool flat
      await app.services.market.refresh(true);
      await app.services.portfolio.markToMarket();
      let pos = (await app.services.repo.listPositions())[0];
      expect(pos.peakPriceSol).toBeCloseTo(1e-6, 15);
      expect(pos.lastPriceSol).toBeCloseTo(1e-6, 15);
      // Pool rises 20% with the quote: peak follows the exit reference.
      clock.advance(10_000);
      provider.observations = [gapObs(clock.now(), 1.2e-6, 1.21e-6)];
      await app.services.market.refresh(true);
      await app.services.portfolio.markToMarket();
      pos = (await app.services.repo.listPositions())[0];
      expect(pos.peakPriceSol).toBeCloseTo(1.2e-6, 15);
      // Then the pool drops 11% from that peak while the quote stays high: trailing stop fires on the exit basis.
      const r = evaluateExit(pos, gapObs(clock.now(), 1.068e-6, 1.19e-6), { ...exitCtx, now: clock.now() });
      expect(r.reasons.some((x) => x.startsWith('trailing_stop'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('an unusable observation does not move last/peak price', async () => {
    const clock = new ManualClock(NOW);
    const provider = new StaticProvider();
    provider.observations = [gapObs(clock.now(), 1e-6, 1e-6)];
    const { app } = await makeApp({ clock, provider });
    try {
      await app.services.market.refresh(true);
      await app.inject({ method: 'POST', url: '/api/orders', payload: { mode: 'PAPER', clientOrderId: 'trail-0002', mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.25 } });
      clock.advance(10_000);
      provider.observations = [makeObs(clock.now(), { priceSol: 3e-6, quoteReserveSol: null, baseReserve: null })];
      await app.services.market.refresh(true);
      await app.services.portfolio.markToMarket();
      const pos = (await app.services.repo.listPositions())[0];
      expect(pos.peakPriceSol).toBeCloseTo(1e-6, 15);
    } finally {
      await app.close();
    }
  });
});

describe('missing or invalid pool data is rejected safely', () => {
  it.each([
    ['reserves missing', { quoteReserveSol: null, baseReserve: null }],
    ['NaN reserve', { quoteReserveSol: Number.NaN }],
    ['infinite reserve', { baseReserve: Number.POSITIVE_INFINITY }],
    ['zero reserve', { quoteReserveSol: 0 }],
    ['gap beyond tolerance', { priceSol: 2e-6 }],
  ])('%s: no entry cost estimate, no exit signal', (_label, overrides) => {
    // Bypass schema validation on purpose: the pricing layer must defend itself too.
    const o = { ...makeObs(NOW), ...overrides } as MarketObservation;
    expect(poolFromObservation(o).ok).toBe(false);
    const entry = evaluateEntry(o, entryCtx);
    expect(entry.action).toBe('SKIP');
    expect(entry.checks.find((c) => c.name === 'max_price_impact')?.passed).toBe(false);
    const pos = applyBuy(undefined, simulateBuy(pool(makeObs(NOW)), 0.25, costs), { mint: 'm', symbol: 'M', now: NOW, liquiditySol: 100 });
    expect(evaluateExit(pos, o, exitCtx).action).toBe('SKIP');
  });

  it('a non-finite or non-positive quoted price is rejected', () => {
    for (const priceSol of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(poolFromObservation({ ...makeObs(NOW), priceSol } as MarketObservation).ok).toBe(false);
    }
  });
});

describe('end to end: bot exit realises its own estimate; accounting invariants hold', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('a stop-loss SELL realises the P&L of the next-observation fill, and cash/fees/realized/equity reconcile', async () => {
    const clock = new ManualClock(NOW);
    const provider = new StaticProvider();
    provider.observations = [gapObs(clock.now(), 1e-6, 1e-6)];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.bot.start();
    await app.services.bot.tick(); // queue BUY
    clock.advance(10_000);
    provider.observations = [gapObs(clock.now(), 1e-6, 1e-6)];
    await app.services.bot.tick(); // fill BUY
    let trades = (await app.inject({ method: 'GET', url: '/api/trades' })).json().items as PaperOrder[];
    expect(trades.map((t) => t.side)).toEqual(['BUY']);

    // Quote shows -8%, pool implies -15%: executable estimate is below the 12% stop.
    clock.advance(10_000);
    const exitSignalObs = gapObs(clock.now(), 0.85e-6, 0.92e-6);
    provider.observations = [exitSignalObs];
    const before = (await app.services.repo.listPositions())[0];
    const signalEstimate = estimateExit(before, pool(exitSignalObs), costs);
    await app.services.bot.tick(); // queue SELL on signal bar
    expect(app.services.bot.pendingCount()).toBe(1);

    // Fill bar uses the same pool as the signal so realized matches the decision estimate
    // (next-bar timing still applies via a newer observedAt).
    clock.advance(10_000);
    const exitFillObs = gapObs(clock.now(), 0.85e-6, 0.92e-6);
    provider.observations = [exitFillObs];
    const fillEstimate = estimateExit(before, pool(exitFillObs), costs);
    await app.services.bot.tick(); // fill SELL

    trades = (await app.inject({ method: 'GET', url: '/api/trades' })).json().items as PaperOrder[];
    const sell = trades.find((t) => t.side === 'SELL')!;
    expect(sell.fill!.observationAt).toBe(exitFillObs.observedAt);
    expect(sell.fill!.realizedPnlSol).toBeCloseTo(fillEstimate.netProceedsSol - before.costBasisSol, 15);
    expect(fillEstimate.netPnlPct).toBeCloseTo(signalEstimate.netPnlPct, 10);
    const decision = ((await app.inject({ method: 'GET', url: '/api/logs/decisions?action=SELL' })).json().items as StrategyDecision[])[0];
    expect(decision.reasons[0]).toContain(`${signalEstimate.netPnlPct.toFixed(2)}%`);
    expect(decision.outcome).toMatch(/filled on next observation/);

    // Invariants
    const s = (await app.inject({ method: 'GET', url: '/api/portfolio' })).json() as PortfolioSummary;
    const all = trades;
    expect(s.cashSol).toBeCloseTo(10 + all.reduce((a, t) => a + t.fill!.cashDeltaSol, 0), 12);
    expect(s.feesPaidSol).toBeCloseTo(all.reduce((a, t) => a + t.fill!.tradingFeeSol + t.fill!.networkFeeSol, 0), 12);
    expect(s.realizedPnlSol).toBeCloseTo(all.reduce((a, t) => a + (t.fill!.realizedPnlSol ?? 0), 0), 12);
    const views = (await app.inject({ method: 'GET', url: '/api/portfolio/positions' })).json().items as PositionView[];
    expect(s.equitySol).toBeCloseTo(s.cashSol + views.reduce((a, v) => a + v.liquidationValueSol, 0), 12);
    expect(s.openPositions).toBe(0);
  });
});
