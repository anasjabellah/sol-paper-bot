import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MarketObservationSchema } from '@spb/shared';
import { MockMarketProvider } from '../src/market/mockProvider';
import { DexScreenerProvider } from '../src/market/dexscreenerProvider';
import { MarketDataService, isStale } from '../src/market/marketService';
import { ProviderError } from '../src/market/provider';
import { poolFromObservation } from '../src/paper/accounting';
import { openDb } from '../src/database/db';
import { migrate } from '../src/database/migrations';
import { Repository } from '../src/database/repository';
import { AuditLogger } from '../src/logging/audit';
import { ManualClock, StaticProvider, makeObs } from './helpers';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-tokens.json', import.meta.url), 'utf8')) as unknown[];
const PUMPFUN_MINT = 'FjQYCiHM7VHFw4Syai5YCKZmy4vSPcDWmzNBuC8fpump';
const PUMPSWAP_MINT = '9uGqEsc5Sh9GBjvLr7jUf7PyY9tDZhiV7kCdyM7Wpump';

describe('MockMarketProvider', () => {
  it('is deterministic for a given seed and clock', async () => {
    const c1 = new ManualClock();
    const c2 = new ManualClock();
    const a = new MockMarketProvider({ seed: 9, tokenCount: 5, clock: c1.now });
    const b = new MockMarketProvider({ seed: 9, tokenCount: 5, clock: c2.now });
    c1.advance(30_000);
    c2.advance(30_000);
    expect((await a.poll()).observations).toEqual((await b.poll()).observations);
  });

  it('produces valid, clearly simulated observations with consistent reserves', async () => {
    const clock = new ManualClock();
    const p = new MockMarketProvider({ seed: 1, tokenCount: 8, clock: clock.now });
    const { observations } = await p.poll();
    expect(observations).toHaveLength(8);
    for (const raw of observations) {
      const o = MarketObservationSchema.parse(raw);
      expect(o.simulated).toBe(true);
      expect(o.mint.startsWith('mock_')).toBe(true);
      expect(poolFromObservation(o).ok).toBe(true);
      expect(o.priceChange5mPct).not.toBeNull();
      // Only 15 min of warm-up history: a 1h change for older tokens is genuinely unavailable.
      if (o.pairCreatedAt! < clock.now() - 3_600_000) expect(o.priceChange1hPct).toBeNull();
    }
  });

  it('freezing produces stale observations', async () => {
    const clock = new ManualClock();
    const p = new MockMarketProvider({ seed: 1, tokenCount: 2, clock: clock.now });
    p.freeze(true);
    clock.advance(120_000);
    const o = MarketObservationSchema.parse((await p.poll()).observations[0]);
    expect(isStale(o, clock.now(), 30_000)).toBe(true);
  });

  it('can inject failures', async () => {
    const p = new MockMarketProvider({ seed: 1, tokenCount: 2, clock: new ManualClock().now, failureRate: 1 });
    await expect(p.poll()).rejects.toBeInstanceOf(ProviderError);
  });
});

function fakeFetch(handler: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  return vi.fn(async (url: string | URL | Request) => {
    const r = handler(String(url));
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
}

describe('DexScreenerProvider', () => {
  const base = {
    baseUrl: 'https://api.example.test',
    dexIds: ['pumpfun', 'pumpswap'],
    maxTracked: 10,
    discoveryIntervalMs: 60_000,
    retryDelaysMs: [0, 0],
  };

  it('maps real response shapes; missing liquidity becomes null, not zero', async () => {
    const clock = new ManualClock(Date.now()); // fixture pairs were created in real time
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/tokens/v1/solana/')) return { status: 200, body: fixture };
      return { status: 200, body: [] };
    });
    const p = new DexScreenerProvider({ ...base, watchlist: [PUMPFUN_MINT, PUMPSWAP_MINT], clock: clock.now, fetchImpl });
    const { observations } = await p.poll();
    const parsed = observations.map((o) => MarketObservationSchema.parse(o));
    const pf = parsed.find((o) => o.mint === PUMPFUN_MINT)!;
    const ps = parsed.find((o) => o.mint === PUMPSWAP_MINT)!;

    expect(pf.simulated).toBe(false);
    expect(pf.source).toBe('dexscreener');
    expect(pf.dexId).toBe('pumpfun');
    expect(pf.quoteReserveSol).toBeNull();
    expect(pf.baseReserve).toBeNull();
    expect(poolFromObservation(pf).ok).toBe(false);
    expect(pf.buys5m).toBeGreaterThanOrEqual(0);

    expect(ps.dexId).toBe('pumpswap');
    expect(ps.quoteReserveSol).toBeCloseTo(113.361, 3);
    expect(ps.priceSol).toBeCloseTo(0.0000008659, 12);
    // volume converted from USD to SOL using priceUsd / priceNative
    expect(ps.volume5mSol).toBeCloseTo(647.08 / (0.00008809 / 0.0000008659), 6);
    expect(ps.observedAt).toBe(clock.now());
  });

  it('ignores non-SOL-quoted pairs and disallowed dexes', async () => {
    const onlyUsdc = [{ ...(fixture[2] as object) }];
    const fetchImpl = fakeFetch(() => ({ status: 200, body: onlyUsdc }));
    const p = new DexScreenerProvider({ ...base, watchlist: [PUMPSWAP_MINT], clock: new ManualClock().now, fetchImpl });
    const r = await p.poll();
    expect(r.observations).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/SOL-quoted/);
  });

  it('discovers solana tokens only and caps the tracked set', async () => {
    const profiles = [
      { chainId: 'solana', tokenAddress: PUMPFUN_MINT },
      { chainId: 'ethereum', tokenAddress: '0xabc' },
      { chainId: 'solana', tokenAddress: 'not-a-mint' },
    ];
    const fetchImpl = fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: fixture } : { status: 200, body: profiles }));
    const p = new DexScreenerProvider({ ...base, watchlist: [], clock: new ManualClock().now, fetchImpl });
    await p.poll();
    expect(p.trackedCount()).toBe(1);
  });

  it('honours HTTP 429 with Retry-After and refuses requests during cooldown', async () => {
    const clock = new ManualClock();
    const fetchImpl = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '20' } }));
    const p = new DexScreenerProvider({ ...base, watchlist: [PUMPSWAP_MINT], clock: clock.now, fetchImpl });
    const err = await p.poll().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryAfterMs).toBe(20_000);
    expect(p.rateLimitedUntil()).toBe(clock.now() + 20_000);
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await expect(p.poll()).rejects.toThrow(/rate-limited/);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it('treats 5xx and invalid JSON as retryable errors', async () => {
    const p1 = new DexScreenerProvider({ ...base, watchlist: [PUMPSWAP_MINT], clock: new ManualClock().now, fetchImpl: fakeFetch(() => ({ status: 503 })) });
    const e1 = await p1.poll().catch((e) => e);
    expect(e1.retryable).toBe(true);
    const badJson = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const p2 = new DexScreenerProvider({ ...base, watchlist: [PUMPSWAP_MINT], clock: new ManualClock().now, fetchImpl: badJson });
    await expect(p2.poll()).rejects.toThrow(/invalid JSON/);
  });

  it('rejects invalid watchlist mints at construction', () => {
    expect(() => new DexScreenerProvider({ ...base, watchlist: ['bad'], clock: Date.now })).toThrow(/valid mint/);
  });
});

async function makeService(provider: StaticProvider, clock: ManualClock) {
  const db = await openDb('sqlite::memory:');
  await migrate(db);
  const repo = new Repository(db);
  const audit = new AuditLogger(repo, pino({ level: 'silent' }), clock.now);
  return { svc: new MarketDataService(provider, repo, audit, clock.now, { pollIntervalMs: 5_000, recordEveryMs: 0 }), repo };
}

describe('MarketDataService', () => {
  it('rejects invalid, future-dated and out-of-order observations and audits them', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    const { svc, repo } = await makeService(provider, clock);
    provider.observations = [
      makeObs(clock.now()),
      { ...makeObs(clock.now(), { mint: 'mock_0002bbb' }), priceSol: -5 },
      makeObs(clock.now() + 60_000, { mint: 'mock_0003ccc' }),
      { garbage: true },
    ];
    await svc.refresh(true);
    expect(svc.all().map((o) => o.mint)).toEqual(['mock_0001aaa']);
    expect(svc.health().rejectedObservations).toBe(3);
    const audit = await repo.listAudit({ limit: 10, offset: 0 });
    expect(audit.some((a) => a.type === 'market.invalid_observations')).toBe(true);

    provider.observations = [makeObs(clock.now() - 10_000)];
    await svc.refresh(true);
    expect(svc.get('mock_0001aaa')?.observedAt).toBe(clock.now());
  });

  it('backs off on failures, reports degraded/down, and recovers', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    const { svc } = await makeService(provider, clock);
    expect(svc.health().state).toBe('starting');
    provider.observations = [makeObs(clock.now())];
    await svc.refresh(true);
    expect(svc.health().state).toBe('ok');

    provider.failWith = new ProviderError('boom', true);
    await svc.refresh(true);
    const h = svc.health();
    expect(h.state).toBe('degraded');
    expect(h.lastError).toBe('boom');
    expect(h.nextPollAt! - clock.now()).toBeGreaterThanOrEqual(10_000);
    // Not due yet: refresh() without force is a no-op during backoff
    provider.failWith = null;
    await svc.refresh();
    expect(svc.health().consecutiveFailures).toBe(1);

    provider.failWith = new ProviderError('boom', true);
    await svc.refresh(true);
    await svc.refresh(true);
    expect(svc.health().state).toBe('down');
    // Last good data is kept (and will become stale) rather than replaced by zeros
    expect(svc.get('mock_0001aaa')?.priceSol).toBe(1e-6);

    provider.failWith = null;
    clock.advance(1_000);
    provider.observations = [makeObs(clock.now())];
    await svc.refresh(true);
    expect(svc.health().state).toBe('ok');
    expect(svc.health().consecutiveFailures).toBe(0);
  });
});
