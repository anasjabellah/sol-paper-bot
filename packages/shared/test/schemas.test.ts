import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RISK_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  MarketObservationSchema,
  OrderRequestSchema,
  REAL_TRADING_ENABLED,
  RiskConfigSchema,
  StrategyConfigSchema,
  TRADING_MODE,
} from '../src';

const baseObs = {
  mint: 'mock_abc123',
  symbol: 'SIM-A',
  name: 'Sim A',
  source: 'mock',
  simulated: true,
  observedAt: Date.now(),
  priceSol: 0.00001,
  priceUsd: null,
  quoteReserveSol: 100,
  baseReserve: 10_000_000,
  liquidityUsd: null,
  volume5mSol: 0,
  volume1hSol: 0,
  buys5m: 0,
  sells5m: 0,
  priceChange5mPct: null,
  priceChange1hPct: null,
  pairCreatedAt: null,
  pairAddress: null,
  dexId: 'mock-amm',
  url: null,
};

describe('safety constants', () => {
  it('are hard-coded to paper mode', () => {
    expect(TRADING_MODE).toBe('PAPER');
    expect(REAL_TRADING_ENABLED).toBe(false);
  });
});

describe('MarketObservationSchema', () => {
  it('accepts a valid mock observation and keeps zero distinct from null', () => {
    const r = MarketObservationSchema.parse(baseObs);
    expect(r.volume5mSol).toBe(0);
    expect(r.priceChange5mPct).toBeNull();
  });

  it('rejects negative, NaN, infinite and zero prices', () => {
    for (const priceSol of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(MarketObservationSchema.safeParse({ ...baseObs, priceSol }).success).toBe(false);
    }
  });

  it('rejects mock data not flagged as simulated', () => {
    expect(MarketObservationSchema.safeParse({ ...baseObs, simulated: false }).success).toBe(false);
  });

  it('requires base58 mint addresses for real data', () => {
    const real = { ...baseObs, source: 'dexscreener', simulated: false };
    expect(MarketObservationSchema.safeParse(real).success).toBe(false);
    expect(
      MarketObservationSchema.safeParse({ ...real, mint: 'FjQYCiHM7VHFw4Syai5YCKZmy4vSPcDWmzNBuC8fpump' }).success,
    ).toBe(true);
  });
});

describe('config schemas', () => {
  it('accept defaults', () => {
    expect(StrategyConfigSchema.safeParse(DEFAULT_STRATEGY_CONFIG).success).toBe(true);
    expect(RiskConfigSchema.safeParse(DEFAULT_RISK_CONFIG).success).toBe(true);
  });
  it('reject inconsistent momentum bounds and unknown keys', () => {
    expect(
      StrategyConfigSchema.safeParse({ ...DEFAULT_STRATEGY_CONFIG, minPriceChange5mPct: 50, maxPriceChange5mPct: 10 }).success,
    ).toBe(false);
    expect(RiskConfigSchema.safeParse({ ...DEFAULT_RISK_CONFIG, enableRealTrading: true }).success).toBe(false);
  });
});

describe('OrderRequestSchema', () => {
  const buy = { mode: 'PAPER', clientOrderId: 'manual-0001', mint: 'mock_x', side: 'BUY', sizeSol: 0.5 };
  it('accepts a paper market buy and defaults type to MARKET', () => {
    const r = OrderRequestSchema.parse(buy);
    expect(r.type).toBe('MARKET');
  });
  it('rejects any mode other than PAPER', () => {
    expect(OrderRequestSchema.safeParse({ ...buy, mode: 'LIVE' }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...buy, mode: undefined }).success).toBe(false);
  });
  it('rejects invalid sizes and limit orders without a limit price', () => {
    expect(OrderRequestSchema.safeParse({ ...buy, sizeSol: 0 }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...buy, sizeSol: -1 }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...buy, type: 'LIMIT' }).success).toBe(false);
    expect(
      OrderRequestSchema.safeParse({ mode: 'PAPER', clientOrderId: 'manual-0002', mint: 'mock_x', side: 'SELL', fraction: 1.5 }).success,
    ).toBe(false);
  });
});
