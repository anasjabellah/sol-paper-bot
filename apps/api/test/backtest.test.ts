import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, type MarketObservation } from '@spb/shared';
import { runBacktest, type BacktestOptions, type Frame } from '../src/backtest/engine';
import { framesFromObservations, syntheticFrames } from '../src/backtest/datasets';
import { poolObs, makeObs } from './helpers';

const opts: BacktestOptions = {
  dataset: 'synthetic',
  dataSource: 'test',
  strategy: DEFAULT_STRATEGY_CONFIG,
  risk: DEFAULT_RISK_CONFIG,
  costs: { tradingFeeBps: 100, slippageBufferBps: 50, networkFeeSol: 0.000105 },
  startingBalanceSol: 10,
};
const T0 = Date.UTC(2026, 0, 1);
const frame = (i: number, obs: MarketObservation[]): Frame => ({ ts: T0 + i * 5000, observations: new Map(obs.map((o) => [o.mint, o])) });

describe('backtest engine', () => {
  it('fills at the NEXT frame (no look-ahead) and reports metrics', () => {
    // Frame 0: entry signal at 1e-6. Frame 1: price 1.1e-6 (fill happens here, at the worse price).
    // Frame 2: price 1.5e-6 => take profit decided; Frame 3: fill exit at 1.45e-6.
    const frames = [
      frame(0, [poolObs(T0, 1e-6)]),
      frame(1, [poolObs(T0 + 5000, 1.1e-6, { priceChange5mPct: 50 })]),
      frame(2, [poolObs(T0 + 10000, 1.5e-6, { priceChange5mPct: 50 })]),
      frame(3, [poolObs(T0 + 15000, 1.45e-6, { priceChange5mPct: 50 })]),
    ];
    const r = runBacktest(frames, opts);
    expect(r.tradeCount).toBe(1);
    const t = r.trades[0];
    expect(t.entryAt).toBe(T0 + 5000); // decided at frame 0, filled at frame 1
    expect(t.exitAt).toBe(T0 + 15000); // decided at frame 2, filled at frame 3
    expect(t.exitReason).toBe('take_profit');
    // Entry used frame-1 pool (1.1e-6), not the frame-0 decision price.
    const expectedQty = ((100 / 1.1e-6) * 0.25) / (100 + 0.25) * 0.995;
    const expectedCost = 0.25 * 1.01 + 0.000105;
    expect(t.costSol).toBeCloseTo(expectedCost, 12);
    const grossOut = ((100 * expectedQty) / (100 / 1.45e-6 + expectedQty)) * 0.995;
    expect(t.proceedsSol).toBeCloseTo(grossOut * 0.99 - 0.000105, 9);
    expect(r.winRatePct).toBe(100);
    expect(r.profitFactor).toBeNull(); // no losing trades
    expect(r.endingEquitySol).toBeCloseTo(10 + t.pnlSol, 9);
    expect(r.netReturnPct).toBeCloseTo((t.pnlSol / 10) * 100, 9);
  });

  it('a signal that only appears in the final frame is never traded', () => {
    const frames = [frame(0, [makeObs(T0, { volume5mSol: 0 })]), frame(1, [makeObs(T0 + 5000)])];
    const r = runBacktest(frames, opts);
    expect(r.tradeCount).toBe(0);
    expect(r.endingEquitySol).toBe(10);
  });

  it('cancels orders when the token disappears from the next frame', () => {
    const frames = [frame(0, [makeObs(T0)]), frame(1, []), frame(2, [])];
    const r = runBacktest(frames, opts);
    expect(r.cancelledOrders).toBe(1);
    expect(r.tradeCount).toBe(0);
  });

  it('computes drawdown, profit factor and losses with costs', () => {
    const frames = [
      frame(0, [poolObs(T0, 1e-6)]),
      frame(1, [poolObs(T0 + 5000, 1e-6)]),
      frame(2, [poolObs(T0 + 10000, 0.8e-6)]), // stop loss decided
      frame(3, [poolObs(T0 + 15000, 0.8e-6)]),
    ];
    const r = runBacktest(frames, opts);
    expect(r.tradeCount).toBe(1);
    expect(r.trades[0].pnlSol).toBeLessThan(0);
    expect(r.winRatePct).toBe(0);
    expect(r.profitFactor).toBe(0);
    expect(r.maxDrawdownPct).toBeGreaterThan(0);
    expect(r.feesPaidSol).toBeGreaterThan(0);
  });

  it('synthetic runs are deterministic and labelled as synthetic', async () => {
    const a = runBacktest(await syntheticFrames(5, 300, 8), opts);
    const b = runBacktest(await syntheticFrames(5, 300, 8), opts);
    expect(a).toEqual(b);
    expect(a.disclaimer).toMatch(/SYNTHETIC/);
    expect(a.assumptions.length).toBeGreaterThan(0);
    expect(a.limitations.length).toBeGreaterThan(0);
  });

  it('buckets recorded observations into ordered frames', () => {
    const f = framesFromObservations([makeObs(T0 + 7000), makeObs(T0 + 1000, { mint: 'mock_0002bbb' }), makeObs(T0 + 2000)], 5000);
    expect(f).toHaveLength(2);
    expect(f[0].observations.size).toBe(2);
    expect(f[1].ts).toBe(T0 + 7000);
  });
});
