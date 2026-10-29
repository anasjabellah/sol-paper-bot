import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MarketObservationSchema } from '@spb/shared';
import { DexScreenerProvider, type DexScreenerOptions } from '../src/market/dexscreenerProvider';
import { MarketDataService } from '../src/market/marketService';
import { ProviderError } from '../src/market/provider';
import { openDb } from '../src/database/db';
import { migrate } from '../src/database/migrations';
import { Repository } from '../src/database/repository';
import { AuditLogger } from '../src/logging/audit';
import { ManualClock, StaticProvider, makeObs, realObs } from './helpers';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-tokens.json', import.meta.url), 'utf8')) as Record<string, unknown>[];
const PUMPSWAP = fixture[1];
const PUMPSWAP_MINT = '9uGqEsc5Sh9GBjvLr7jUf7PyY9tDZhiV7kCdyM7Wpump';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeMint = (i: number) => `${'A'.repeat(40)}${B58[Math.floor(i / 58) % 58]}${B58[i % 58]}`;

type Handler = (url: string, n: number) => { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';
function fakeFetch(handler: Handler) {
  let n = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), n++);
    if (r === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return new Response(r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    });
  });
  return fn as unknown as typeof fetch & { mock: { calls: [string][] } };
}
const urls = (f: { mock: { calls: [string][] } }) => f.mock.calls.map((c) => String(c[0]));

function provider(over: Partial<DexScreenerOptions> & { fetchImpl: typeof fetch }, clock = new ManualClock(Date.now())) {
  return new DexScreenerProvider({
    baseUrl: 'https://api.example.test',
    dexIds: ['pumpfun', 'pumpswap'],
    watchlist: [PUMPSWAP_MINT],
    maxTracked: 100,
    discoveryIntervalMs: 60_000,
    retryDelaysMs: [0, 0],
    minPollIntervalMs: 10_000,
    clock: clock.now,
    ...over,
  });
}

describe('DexScreener retries, timeouts and rate limits', () => {
  it('retries transient 5xx failures and then succeeds', async () => {
    const f = fakeFetch((url, n) => (url.includes('/tokens/v1/') && n < 2 ? { status: 502 } : url.includes('/tokens/v1/') ? { status: 200, body: [PUMPSWAP] } : { status: 200, body: [] }));
    const p = provider({ fetchImpl: f, discoveryIntervalMs: 10_000_000 });
    // Skip discovery for this test by pre-dating it
    (p as unknown as { lastDiscoveryAt: number }).lastDiscoveryAt = Date.now();
    const r = await p.poll();
    expect(r.observations).toHaveLength(1);
    expect(urls(f).filter((u) => u.includes('/tokens/v1/'))).toHaveLength(3);
  });

  it('gives up after the bounded number of retries', async () => {
    const f = fakeFetch(() => ({ status: 503 }));
    const p = provider({ fetchImpl: f });
    await expect(p.poll()).rejects.toThrow(/HTTP 503/);
    // 4 list discovery sources (no search query configured) + 1 pair chunk, each tried 3 times
    expect(f.mock.calls.length).toBe((4 + 1) * 3);
  });

  it('never retries a 429 and stops discovery after the first one', async () => {
    const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '7' } }));
    const clock = new ManualClock(Date.now());
    const p = provider({ fetchImpl: f }, clock);
    const err = await p.poll().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(f.mock.calls.length).toBe(1);
    expect(p.rateLimitedUntil()).toBe(clock.now() + 7_000);
    expect(p.discoveryStatus().find((s) => s.source === 'token-profiles/latest')?.lastError).toMatch(/429/);
  });

  it('times out hung requests', async () => {
    const f = fakeFetch(() => 'hang');
    const p = provider({ fetchImpl: f, timeoutMs: 20, retryDelaysMs: [] });
    await expect(p.poll()).rejects.toThrow(/timed out/);
  });

  it('rejects non-JSON bodies and unexpected shapes', async () => {
    const html = fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: '<html>' } : { status: 200, body: [] }));
    await expect(provider({ fetchImpl: html }).poll()).rejects.toThrow(/invalid JSON/);
    const obj = fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: { pairs: [] } } : { status: 200, body: [] }));
    await expect(provider({ fetchImpl: obj }).poll()).rejects.toThrow(/unexpected response shape/);
  });
});

describe('DexScreener parsing and data quality', () => {
  it('ignores malformed pair records and reports them as warnings', async () => {
    const f = fakeFetch((url) =>
      url.includes('/tokens/v1/') ? { status: 200, body: [PUMPSWAP, { junk: true }, { chainId: 'solana', dexId: 5 }] } : { status: 200, body: [] },
    );
    const r = await provider({ fetchImpl: f }).poll();
    expect(r.observations).toHaveLength(1);
    expect(r.warnings?.join(' ')).toMatch(/2 malformed pair record/);
  });

  it('marks half-present reserves as unavailable (never invents the missing side)', async () => {
    const pair = { ...PUMPSWAP, liquidity: { usd: 1000, quote: 50 } };
    const f = fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: [pair] } : { status: 200, body: [] }));
    const o = MarketObservationSchema.parse((await provider({ fetchImpl: f }).poll()).observations[0]);
    expect(o.quoteReserveSol).toBeNull();
    expect(o.baseReserve).toBeNull();
    expect(o.liquidityUsd).toBe(1000);
  });

  it('keeps genuine zeros and drops non-numeric / non-https values', async () => {
    const pair = {
      ...PUMPSWAP,
      url: 'javascript:alert(1)',
      volume: { m5: 0, h1: 0 },
      txns: { m5: { buys: 0, sells: 0 } },
      priceChange: { m5: null },
      priceUsd: 'not-a-number',
    };
    const f = fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: [pair] } : { status: 200, body: [] }));
    const o = MarketObservationSchema.parse((await provider({ fetchImpl: f }).poll()).observations[0]);
    expect(o.url).toBeNull();
    expect(o.buys5m).toBe(0);
    expect(o.sells5m).toBe(0);
    expect(o.priceUsd).toBeNull();
    expect(o.volume5mSol).toBeNull(); // cannot convert USD volume without a USD price: unavailable, not 0
    expect(o.priceChange5mPct).toBeNull();
  });

  it('serves repeated polls from cache within the minimum interval', async () => {
    const clock = new ManualClock(Date.now());
    const f = fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: [PUMPSWAP] } : { status: 200, body: [] }));
    const p = provider({ fetchImpl: f }, clock);
    const a = await p.poll();
    const calls = f.mock.calls.length;
    clock.advance(3_000);
    const b = await p.poll();
    expect(f.mock.calls.length).toBe(calls);
    expect(b).toBe(a);
    clock.advance(10_000);
    await p.poll();
    expect(f.mock.calls.length).toBeGreaterThan(calls);
  });

  it('tolerates a failed chunk when other chunks succeed', async () => {
    const watchlist = Array.from({ length: 35 }, (_, i) => fakeMint(i));
    const f = fakeFetch((url) => {
      if (!url.includes('/tokens/v1/')) return { status: 200, body: [] };
      if (url.includes(watchlist[0])) return { status: 500 };
      return { status: 200, body: [{ ...PUMPSWAP, baseToken: { address: watchlist[34], symbol: 'LAST', name: 'Last' } }] };
    });
    const r = await provider({ fetchImpl: f, watchlist }).poll();
    expect(r.observations).toHaveLength(1);
    expect(r.warnings?.some((w) => w.startsWith('pair data chunk failed'))).toBe(true);
  });
});

describe('DexScreener discovery', () => {
  it('isolates failing sources and uses documented search results as a heuristic', async () => {
    const searchPairs = {
      pairs: [
        { ...PUMPSWAP, dexId: 'pumpfun', baseToken: { address: fakeMint(1), symbol: 'NEW' } },
        { ...PUMPSWAP, chainId: 'ethereum', baseToken: { address: fakeMint(2) } },
        { ...PUMPSWAP, dexId: 'raydium', baseToken: { address: fakeMint(3) } },
      ],
    };
    const f = fakeFetch((url) => {
      if (url.includes('/token-boosts/top/v1')) return { status: 404 };
      if (url.includes('/token-profiles/latest/v1')) return { status: 200, body: [{ chainId: 'solana', tokenAddress: fakeMint(4) }] };
      if (url.includes('/latest/dex/search?q=pumpfun')) return { status: 200, body: searchPairs };
      if (url.includes('/tokens/v1/')) return { status: 200, body: [] };
      return { status: 200, body: [] };
    });
    const p = provider({ fetchImpl: f, watchlist: [], searchQueries: ['pumpfun'] });
    await p.poll();
    const status = Object.fromEntries(p.discoveryStatus().map((s) => [s.source, s]));
    expect(status['token-boosts/top'].lastError).toMatch(/404/);
    expect(status['token-profiles/latest'].lastCount).toBe(1);
    expect(status['search:pumpfun'].lastCount).toBe(1); // only the solana pump.fun pair
    expect(urls(f).every((u) => u.startsWith('https://api.example.test/'))).toBe(true);
    // Tokens that returned no usable pair are evicted, freeing tracking slots
    expect(p.trackedCount()).toBe(0);
  });

  it('only ever issues GET requests to documented paths', async () => {
    const f = fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: [PUMPSWAP] } : { status: 200, body: [] }));
    await provider({ fetchImpl: f, searchQueries: ['pumpfun'] }).poll();
    const documented = [/\/token-profiles\/latest\/v1$/, /\/token-boosts\/(latest|top)\/v1$/, /\/community-takeovers\/latest\/v1$/, /\/latest\/dex\/search\?q=/, /\/tokens\/v1\/solana\//];
    for (const [i, call] of f.mock.calls.entries()) {
      expect(documented.some((re) => re.test(String(call[0]))), String(call[0])).toBe(true);
      const init = (f.mock.calls[i] as unknown as [string, RequestInit])[1];
      expect(init.method).toBe('GET');
    }
  });
});

describe('MarketDataService data-source separation', () => {
  async function svc(provider: StaticProvider, clock: ManualClock) {
    const db = await openDb('sqlite::memory:');
    await migrate(db);
    const repo = new Repository(db);
    return new MarketDataService(provider, repo, new AuditLogger(repo, pino({ level: 'silent' }), clock.now), clock.now, {
      pollIntervalMs: 5_000,
      recordEveryMs: 0,
    });
  }

  it('rejects mock records coming from a real provider and vice versa', async () => {
    const clock = new ManualClock();
    const real = new StaticProvider('dexscreener');
    real.observations = [makeObs(clock.now()), realObs(clock.now())];
    const s = await svc(real, clock);
    await s.refresh(true);
    expect(s.all().map((o) => o.source)).toEqual(['dexscreener']);
    expect(s.health().rejectedObservations).toBe(1);
  });

  it('rejects future-dated pair creation times', async () => {
    const clock = new ManualClock();
    const real = new StaticProvider('dexscreener');
    real.observations = [realObs(clock.now(), { pairCreatedAt: clock.now() + 3_600_000 })];
    const s = await svc(real, clock);
    await s.refresh(true);
    expect(s.all()).toHaveLength(0);
  });

  it('clears all observations and health when the provider is swapped', async () => {
    const clock = new ManualClock();
    const mock = new StaticProvider('mock');
    mock.observations = [makeObs(clock.now())];
    const s = await svc(mock, clock);
    await s.refresh(true);
    expect(s.all()).toHaveLength(1);
    const real = new StaticProvider('dexscreener');
    real.observations = [realObs(clock.now())];
    await s.setProvider(real);
    expect(s.all()).toHaveLength(0);
    expect(s.health()).toMatchObject({ provider: 'dexscreener', simulated: false, state: 'starting', lastSuccessAt: null });
    await s.refresh();
    expect(s.all().map((o) => o.mint)).toEqual([realObs(0).mint]);
  });

  it('reports "starting" (not "ok") while the first poll is still in flight', async () => {
    const clock = new ManualClock();
    let release!: () => void;
    const slow = new StaticProvider('dexscreener');
    slow.observations = [realObs(clock.now())];
    const original = slow.poll.bind(slow);
    slow.poll = () => new Promise((r) => (release = () => r(original())));
    const s = await svc(slow, clock);
    const pending = s.refresh(true);
    expect(s.health().state).toBe('starting');
    release();
    await pending;
    expect(s.health().state).toBe('ok');
  });

  it('respects the provider minimum poll interval', async () => {
    const clock = new ManualClock();
    const p = new StaticProvider('dexscreener');
    Object.assign(p, { minPollIntervalMs: 15_000 });
    const s = await svc(p, clock);
    await s.refresh(true);
    expect(s.pollIntervalMs()).toBe(15_000);
    clock.advance(6_000);
    await s.refresh();
    expect(p.polls).toBe(1);
    clock.advance(10_000);
    await s.refresh();
    expect(p.polls).toBe(2);
  });
});
