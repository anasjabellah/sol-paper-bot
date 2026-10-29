import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, type Position } from '@spb/shared';
import { evaluateEntry, evaluateExit, type EntryContext } from '../src/strategy/momentumStrategy';
import { makeObs, poolObs } from './helpers';

const NOW = Date.UTC(2026, 5, 1);
const ctx = (o: Partial<EntryContext> = {}): EntryContext => ({
  now: NOW,
  strategy: DEFAULT_STRATEGY_CONFIG,
  risk: DEFAULT_RISK_CONFIG,
  costs: { tradingFeeBps: 100, slippageBufferBps: 50, networkFeeSol: 0.000105 },
  held: false,
  lastExitAt: null,
  ...o,
});
const failedNames = (r: { checks: { name: string; passed: boolean }[] }) => r.checks.filter((c) => !c.passed).map((c) => c.name);

describe('evaluateEntry', () => {
  it('BUYs when every rule passes and records all checks', () => {
    const r = evaluateEntry(makeObs(NOW), ctx());
    expect(r.action).toBe('BUY');
    expect(r.sizeSol).toBe(DEFAULT_STRATEGY_CONFIG.orderSizeSol);
    expect(r.checks.length).toBeGreaterThanOrEqual(11);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it.each([
    ['min_liquidity', { quoteReserveSol: 10, baseReserve: 1e7 }],
    ['min_txns_5m', { buys5m: 5, sells5m: 2 }],
    ['min_volume_5m', { volume5mSol: 1 }],
    ['momentum_5m', { priceChange5mPct: 1 }],
    ['momentum_5m', { priceChange5mPct: 90 }],
    ['buy_sell_ratio', { buys5m: 20, sells5m: 30 }],
    ['token_age', { pairCreatedAt: NOW - 60_000 }],
    ['data_fresh', { observedAt: NOW - 120_000 }],
  ])('SKIPs when %s fails', (name, overrides) => {
    const r = evaluateEntry(makeObs(NOW, overrides), ctx());
    expect(r.action).toBe('SKIP');
    expect(failedNames(r)).toContain(name);
  });

  it('rejects when required data is unavailable (null is never treated as zero)', () => {
    for (const [field, check] of [
      ['quoteReserveSol', 'min_liquidity'],
      ['volume5mSol', 'min_volume_5m'],
      ['buys5m', 'min_txns_5m'],
      ['priceChange5mPct', 'momentum_5m'],
      ['pairCreatedAt', 'token_age'],
      ['priceSol', 'price_available'],
    ] as const) {
      const r = evaluateEntry(makeObs(NOW, { [field]: null }), ctx());
      expect(r.action, field).toBe('SKIP');
      expect(failedNames(r), field).toContain(check);
    }
  });

  it('allows unknown token age only when not required', () => {
    const r = evaluateEntry(makeObs(NOW, { pairCreatedAt: null }), ctx({ strategy: { ...DEFAULT_STRATEGY_CONFIG, requireTokenAge: false } }));
    expect(r.action).toBe('BUY');
  });

  it('rejects when estimated price impact is too high', () => {
    const r = evaluateEntry(makeObs(NOW), ctx({ strategy: { ...DEFAULT_STRATEGY_CONFIG, orderSizeSol: 10 } }));
    expect(failedNames(r)).toContain('max_price_impact');
  });

  it('respects held positions and post-exit cooldown', () => {
    expect(failedNames(evaluateEntry(makeObs(NOW), ctx({ held: true })))).toContain('not_already_held');
    expect(failedNames(evaluateEntry(makeObs(NOW), ctx({ lastExitAt: NOW - 60_000 })))).toContain('cooldown');
    expect(evaluateEntry(makeObs(NOW), ctx({ lastExitAt: NOW - 31 * 60_000 })).action).toBe('BUY');
  });

  it('is deterministic', () => {
    const a = evaluateEntry(makeObs(NOW), ctx());
    const b = evaluateEntry(makeObs(NOW), ctx());
    expect(a).toEqual(b);
  });
});

describe('evaluateExit', () => {
  // 1,000,000 tokens bought for 1 SOL total (fee-inclusive): break-even 1e-6 SOL/token.
  const position: Position = {
    mint: 'mock_0001aaa',
    symbol: 'SIM-AAA',
    quantity: 1_000_000,
    costBasisSol: 1,
    avgEntryPriceSol: 1e-6,
    avgFillPriceSol: 0.98e-6,
    openedAt: NOW - 10 * 60_000,
    updatedAt: NOW,
    entryLiquiditySol: 100,
    peakPriceSol: 1e-6,
    lastPriceSol: 1e-6,
    lastPriceAt: NOW,
    realizedPnlSol: 0,
  };
  const ex = {
    now: NOW,
    strategy: DEFAULT_STRATEGY_CONFIG,
    risk: DEFAULT_RISK_CONFIG,
    costs: { tradingFeeBps: 100, slippageBufferBps: 50, networkFeeSol: 0.000105 },
  };

  // poolObs keeps reserves consistent with the price (100 SOL pool unless overridden).
  it('holds when no exit condition fires', () => {
    expect(evaluateExit(position, poolObs(NOW, 1.05e-6), ex).action).toBe('SKIP');
  });
  it('takes profit', () => {
    const r = evaluateExit(position, poolObs(NOW, 1.3e-6), ex);
    expect(r.action).toBe('SELL');
    expect(r.reasons[0]).toMatch(/^take_profit: net P&L at estimated executable exit/);
  });
  it('stops out', () => {
    expect(evaluateExit(position, poolObs(NOW, 0.85e-6), ex).reasons[0]).toMatch(/^stop_loss/);
  });
  it('trails from the peak only once above entry', () => {
    const r = evaluateExit({ ...position, peakPriceSol: 1.2e-6 }, poolObs(NOW, 1.07e-6), ex);
    expect(r.action).toBe('SELL');
    expect(r.reasons.some((x) => x.startsWith('trailing_stop'))).toBe(true);
  });
  it('exits after max hold time', () => {
    const r = evaluateExit({ ...position, openedAt: NOW - 61 * 60_000 }, makeObs(NOW), ex);
    expect(r.reasons.some((x) => x.startsWith('max_hold_time'))).toBe(true);
  });
  it('exits on liquidity collapse', () => {
    const r = evaluateExit(position, poolObs(NOW, 1e-6, { quoteReserveSol: 40 }), ex);
    expect(r.reasons.some((x) => x.startsWith('liquidity_drop'))).toBe(true);
  });
  it('does not act on stale or missing data', () => {
    expect(evaluateExit(position, makeObs(NOW - 120_000, { priceSol: 0.1e-6 }), ex).action).toBe('SKIP');
    expect(evaluateExit(position, undefined, ex).action).toBe('SKIP');
  });
  it('does not signal an exit it could not execute (unusable pool data)', () => {
    // Reserves missing: a SELL cannot be modelled, so no exit decision (and no rejected-order churn).
    const r = evaluateExit(position, makeObs(NOW, { priceSol: 0.5e-6, quoteReserveSol: null, baseReserve: null }), ex);
    expect(r.action).toBe('SKIP');
    expect(r.reasons[0]).toMatch(/cannot evaluate exit: pool reserves unavailable/);
    expect(r.checks.find((c) => c.name === 'exit_executable')?.passed).toBe(false);
  });
});
