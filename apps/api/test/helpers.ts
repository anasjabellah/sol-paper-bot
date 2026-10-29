import type { FastifyInstance } from 'fastify';
import type { MarketObservation, MarketSource } from '@spb/shared';
import { loadConfig, type AppConfig } from '../src/config/env';
import { buildApp } from '../src/app';
import type { MarketDataProvider, ProviderPollResult } from '../src/market/provider';
import type { ProviderFactory } from '../src/services/marketControlService';

export class ManualClock {
  constructor(public t = Date.UTC(2026, 5, 1, 12, 0, 0)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

/** Provider whose observations are set directly by the test. */
export class StaticProvider implements MarketDataProvider {
  readonly simulated: boolean;
  readonly minPollIntervalMs = 0;
  observations: unknown[] = [];
  polls = 0;
  constructor(readonly name: MarketSource = 'mock') {
    this.simulated = name === 'mock';
  }
  failWith: Error | null = null;
  async poll(): Promise<ProviderPollResult> {
    this.polls++;
    if (this.failWith) throw this.failWith;
    return { observations: this.observations.map((o) => ({ ...(o as object) })), skipped: [] };
  }
  trackedCount() {
    return this.observations.length;
  }
  rateLimitedUntil() {
    return null;
  }
  discoveryStatus() {
    return [];
  }
  describe() {
    return `static test provider (${this.name})`;
  }
}

/** An observation that passes every default entry rule at time `now`. */
export function makeObs(now: number, overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    mint: 'mock_0001aaa',
    symbol: 'SIM-AAA',
    name: 'Simulated AAA',
    source: 'mock',
    simulated: true,
    observedAt: now,
    priceSol: 1e-6,
    priceUsd: null,
    quoteReserveSol: 100,
    baseReserve: 1e8,
    liquidityUsd: null,
    volume5mSol: 20,
    volume1hSol: 100,
    buys5m: 40,
    sells5m: 20,
    priceChange5mPct: 10,
    priceChange1hPct: 20,
    pairCreatedAt: now - 60 * 60_000,
    pairAddress: null,
    dexId: 'mock-amm',
    url: null,
    ...overrides,
  };
}

/** Pool observation consistent with a given price (keeps reserves and price in sync). */
export function poolObs(now: number, priceSol: number, overrides: Partial<MarketObservation> = {}): MarketObservation {
  const q = overrides.quoteReserveSol ?? 100;
  return makeObs(now, { priceSol, quoteReserveSol: q, baseReserve: q / priceSol, ...overrides });
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ DATABASE_URL: 'sqlite::memory:', LOG_LEVEL: 'silent', ...env });
}

export async function makeApp(
  opts: { provider?: MarketDataProvider; clock?: ManualClock; config?: AppConfig; providerFactory?: ProviderFactory } = {},
) {
  const clock = opts.clock ?? new ManualClock();
  // With a factory and no explicit provider, let the app choose (env / persisted selection).
  const provider = opts.provider ?? (opts.providerFactory ? undefined : new StaticProvider());
  const app: FastifyInstance = await buildApp(opts.config ?? testConfig(), {
    clock: clock.now,
    provider,
    providerFactory: opts.providerFactory,
    startScheduler: false,
    logger: false,
  });
  return { app, clock, provider };
}

let seq = 0;
export const cid = (prefix = 'test') => `${prefix}-${Date.now().toString(36)}-${(seq++).toString().padStart(4, '0')}`;

/** A real-data (DexScreener-shaped) observation with a base58 mint. */
export const REAL_MINT = '9uGqEsc5Sh9GBjvLr7jUf7PyY9tDZhiV7kCdyM7Wpump';
export function realObs(now: number, overrides: Partial<MarketObservation> = {}): MarketObservation {
  return makeObs(now, {
    mint: REAL_MINT,
    symbol: 'N64',
    name: 'Real token',
    source: 'dexscreener',
    simulated: false,
    dexId: 'pumpswap',
    url: 'https://dexscreener.com/solana/pair',
    ...overrides,
  });
}
