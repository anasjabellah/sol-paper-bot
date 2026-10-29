import { describe, expect, it } from 'vitest';
import type { CostConfig } from '@spb/shared';
import {
  applyBuy,
  applySell,
  estimateBuyImpactPct,
  poolFromObservation,
  simulateBuy,
  simulateSell,
  summarize,
  valuePosition,
  type AccountState,
} from '../src/paper/accounting';
import { makeObs } from './helpers';

const costs: CostConfig = { tradingFeeBps: 100, slippageBufferBps: 50, networkFeeSol: 0.000105 };
const zeroCosts: CostConfig = { tradingFeeBps: 0, slippageBufferBps: 0, networkFeeSol: 0 };
const pool = { spotPriceSol: 1e-6, quoteReserveSol: 100, baseReserve: 1e8 };
const T = 1_700_000_000_000;

describe('simulateBuy', () => {
  it('applies AMM impact, slippage buffer, trading fee and network fee', () => {
    const b = simulateBuy(pool, 1, costs);
    const ammOut = (1e8 * 1) / 101;
    expect(b.quantity).toBeCloseTo(ammOut * 0.995, 6);
    expect(b.tradingFeeSol).toBeCloseTo(0.01, 12);
    expect(b.networkFeeSol).toBe(0.000105);
    expect(b.totalCostSol).toBeCloseTo(1.010105, 12);
    expect(b.priceSol).toBeCloseTo(1 / (ammOut * 0.995), 15);
    expect(b.priceImpactPct).toBeCloseTo(((101 / 100) / 0.995 - 1) * 100, 6);
    expect(b.priceImpactPct).toBeCloseTo(estimateBuyImpactPct(100, 1, 50), 9);
  });

  it('larger orders get worse average prices', () => {
    expect(simulateBuy(pool, 5, costs).priceSol).toBeGreaterThan(simulateBuy(pool, 1, costs).priceSol);
  });

  it('rejects invalid sizes', () => {
    for (const s of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => simulateBuy(pool, s, costs)).toThrow(RangeError);
  });
});

describe('simulateSell', () => {
  it('charges fees on proceeds and returns less than spot value', () => {
    const s = simulateSell(pool, 1_000_000, costs);
    const ammOut = (100 * 1e6) / (1e8 + 1e6);
    expect(s.grossSol).toBeCloseTo(ammOut * 0.995, 12);
    expect(s.tradingFeeSol).toBeCloseTo(s.grossSol * 0.01, 12);
    expect(s.netProceedsSol).toBeCloseTo(s.grossSol - s.tradingFeeSol - 0.000105, 12);
    expect(s.netProceedsSol).toBeLessThan(1_000_000 * 1e-6);
  });

  it('a zero-cost round trip in an untouched pool returns exactly the input', () => {
    const b = simulateBuy(pool, 2, zeroCosts);
    const after = { spotPriceSol: 102 / (1e8 - b.quantity), quoteReserveSol: 102, baseReserve: 1e8 - b.quantity };
    const s = simulateSell(after, b.quantity, zeroCosts);
    expect(s.netProceedsSol).toBeCloseTo(2, 9);
  });
});

describe('position accounting', () => {
  it('capitalizes fees into cost basis and computes average entry', () => {
    const b1 = simulateBuy(pool, 1, costs);
    const p1 = applyBuy(undefined, b1, { mint: 'm', symbol: 'M', now: T, liquiditySol: 100 });
    expect(p1.costBasisSol).toBeCloseTo(b1.totalCostSol, 12);
    expect(p1.avgEntryPriceSol).toBeCloseTo(b1.totalCostSol / b1.quantity, 18);
    expect(p1.avgEntryPriceSol).toBeGreaterThan(p1.avgFillPriceSol);

    const pool2 = { spotPriceSol: 2e-6, quoteReserveSol: 100, baseReserve: 5e7 };
    const b2 = simulateBuy(pool2, 1, costs);
    const p2 = applyBuy(p1, b2, { mint: 'm', symbol: 'M', now: T + 1, liquiditySol: 100 });
    expect(p2.quantity).toBeCloseTo(b1.quantity + b2.quantity, 6);
    expect(p2.costBasisSol).toBeCloseTo(b1.totalCostSol + b2.totalCostSol, 12);
    expect(p2.avgEntryPriceSol).toBeCloseTo(p2.costBasisSol / p2.quantity, 18);
    expect(p2.avgFillPriceSol).toBeCloseTo((b1.priceSol * b1.quantity + b2.priceSol * b2.quantity) / p2.quantity, 18);
    expect(p2.openedAt).toBe(T);
  });

  it('partial sell releases proportional cost basis and realizes P&L net of entry and exit costs', () => {
    const b = simulateBuy(pool, 1, costs);
    const p = applyBuy(undefined, b, { mint: 'm', symbol: 'M', now: T, liquiditySol: 100 });
    const s = simulateSell(pool, p.quantity / 2, costs);
    const r = applySell(p, s, T + 1);
    expect(r.costBasisReleasedSol).toBeCloseTo(p.costBasisSol / 2, 12);
    expect(r.realizedPnlSol).toBeCloseTo(s.netProceedsSol - p.costBasisSol / 2, 12);
    expect(r.position?.quantity).toBeCloseTo(p.quantity / 2, 6);
    expect(r.position?.avgEntryPriceSol).toBeCloseTo(p.avgEntryPriceSol, 18);
    expect(r.position?.realizedPnlSol).toBeCloseTo(r.realizedPnlSol, 12);
  });

  it('full sell closes the position; round trip at unchanged price loses roughly the costs', () => {
    const b = simulateBuy(pool, 1, costs);
    const p = applyBuy(undefined, b, { mint: 'm', symbol: 'M', now: T, liquiditySol: 100 });
    const s = simulateSell(pool, p.quantity, costs);
    const r = applySell(p, s, T + 1);
    expect(r.position).toBeNull();
    expect(r.costBasisReleasedSol).toBeCloseTo(p.costBasisSol, 12);
    expect(r.realizedPnlSol).toBeLessThan(0);
    // two fees (~1% each), two network fees, two slippage buffers (~0.5% each) + impact
    expect(r.realizedPnlSol).toBeGreaterThan(-0.06);
  });

  it('cannot sell more than held', () => {
    const b = simulateBuy(pool, 1, costs);
    const p = applyBuy(undefined, b, { mint: 'm', symbol: 'M', now: T, liquiditySol: 100 });
    expect(() => applySell(p, simulateSell(pool, p.quantity * 2, costs), T)).toThrow(RangeError);
  });
});

describe('conservative anchoring when quoted and reserve prices disagree', () => {
  it('buys at the higher price and sells at the lower one', () => {
    const higherQuote = { ...pool, quotedPriceSol: 1.1e-6 }; // quote 10% above reserve-implied
    const b0 = simulateBuy(pool, 1, costs);
    const b1 = simulateBuy(higherQuote, 1, costs);
    expect(b1.quantity).toBeCloseTo(b0.quantity / 1.1, 3);
    expect(b1.priceSol).toBeGreaterThan(b0.priceSol);
    // A quote ABOVE reserves must not make sells better than the reserve model...
    expect(simulateSell(higherQuote, 1e6, costs).netProceedsSol).toBeCloseTo(simulateSell(pool, 1e6, costs).netProceedsSol, 12);
    // ...and a quote BELOW reserves makes sells worse, buys unchanged.
    const lowerQuote = { ...pool, quotedPriceSol: 0.9e-6 };
    expect(simulateSell(lowerQuote, 1e6, costs).grossSol).toBeCloseTo(simulateSell(pool, 1e6, costs).grossSol * 0.9, 12);
    expect(simulateBuy(lowerQuote, 1, costs).quantity).toBeCloseTo(b0.quantity, 6);
  });

  it('poolFromObservation carries the quoted price', () => {
    const r = poolFromObservation(makeObs(T, { priceSol: 1.1e-6 }));
    expect(r.ok && r.pool.quotedPriceSol).toBe(1.1e-6);
  });
});

describe('poolFromObservation', () => {
  it('rejects missing reserves and price/reserve disagreement', () => {
    expect(poolFromObservation(makeObs(T, { quoteReserveSol: null })).ok).toBe(false);
    expect(poolFromObservation(makeObs(T, { priceSol: null })).ok).toBe(false);
    expect(poolFromObservation(makeObs(T, { priceSol: 2e-6 })).ok).toBe(false);
    expect(poolFromObservation(makeObs(T)).ok).toBe(true);
  });
});

describe('valuation', () => {
  const b = simulateBuy(pool, 1, costs);
  const p = applyBuy(undefined, b, { mint: 'mock_0001aaa', symbol: 'M', now: T, liquiditySol: 100 });

  it('values conservatively at modelled liquidation value', () => {
    const v = valuePosition(p, makeObs(T), T, 30_000, costs);
    expect(v.valuationMethod).toBe('amm-liquidation');
    expect(v.liquidationValueSol).toBeLessThan(v.marketValueSol);
    expect(v.unrealizedPnlSol).toBeCloseTo(v.liquidationValueSol - p.costBasisSol, 12);
    expect(v.priceStale).toBe(false);
  });

  it('flags stale prices and falls back to last known price without data', () => {
    expect(valuePosition(p, makeObs(T - 60_000), T, 30_000, costs).priceStale).toBe(true);
    const v = valuePosition(p, undefined, T, 30_000, costs);
    expect(v.valuationMethod).toBe('last-known-price');
    expect(v.priceStale).toBe(true);
  });

  it('summarizes equity, P&L, drawdown and daily P&L', () => {
    const account: AccountState = {
      startingBalanceSol: 10,
      cashSol: 10 - b.totalCostSol,
      realizedPnlSol: 0,
      feesPaidSol: b.tradingFeeSol + b.networkFeeSol,
      peakEquitySol: 10,
      dayKey: '2023-11-14',
      dayStartEquitySol: 10,
      createdAt: T,
    };
    const v = valuePosition(p, makeObs(T), T, 30_000, costs);
    const s = summarize(account, [v], T);
    expect(s.equitySol).toBeCloseTo(account.cashSol + v.liquidationValueSol, 12);
    expect(s.totalPnlSol).toBeCloseTo(s.equitySol - 10, 12);
    expect(s.drawdownPct).toBeCloseTo(((10 - s.equitySol) / 10) * 100, 9);
    expect(s.dailyPnlSol).toBeCloseTo(s.equitySol - 10, 12);
    expect(s.openPositions).toBe(1);
    expect(s.mode).toBe('PAPER');
  });
});
