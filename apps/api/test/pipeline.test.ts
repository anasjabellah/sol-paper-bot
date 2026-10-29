import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PaperOrder, StrategyDecision, StrategyPipelineSummary, TokenView } from '@spb/shared';
import { DexScreenerProvider } from '../src/market/dexscreenerProvider';
import { ManualClock, makeApp } from './helpers';

/**
 * End-to-end DEXSCREENER-mode checks using the REAL DexScreenerProvider with a
 * deterministic fake HTTP layer (no network). Nothing here asserts profitability.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-tokens.json', import.meta.url), 'utf8')) as Record<string, unknown>[];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mintN = (i: number) => `${'B'.repeat(40)}${B58[Math.floor(i / 58) % 58]}${B58[i % 58]}`;
const ELIGIBLE = mintN(0);

/** A PumpSwap pair that satisfies every default entry rule at `now`. */
function eligiblePair(now: number, overrides: Record<string, unknown> = {}) {
  const quote = 120; // SOL in pool
  const price = 1e-6; // SOL per token, consistent with reserves
  return {
    ...fixture[1],
    pairAddress: 'PairAddr' + '1'.repeat(36),
    dexId: 'pumpswap',
    baseToken: { address: ELIGIBLE, name: 'Eligible', symbol: 'ELIG' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceNative: String(price),
    priceUsd: String(price * 150),
    liquidity: { usd: quote * 2 * 150, base: quote / price, quote },
    volume: { m5: 20 * 150, h1: 100 * 150 }, // 20 SOL in 5m
    txns: { m5: { buys: 40, sells: 20 } },
    priceChange: { m5: 10, h1: 20 },
    pairCreatedAt: now - 2 * 3_600_000,
    ...overrides,
  };
}

function fakeFetch(pairsFor: (mints: string[]) => unknown[], discovery: () => unknown[] = () => []) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/tokens/v1/solana/')) {
      const mints = decodeURIComponent(u.split('/tokens/v1/solana/')[1]).split(',');
      return new Response(JSON.stringify(pairsFor(mints)), { status: 200 });
    }
    if (u.includes('/latest/dex/search')) return new Response(JSON.stringify({ pairs: [] }), { status: 200 });
    return new Response(JSON.stringify(discovery()), { status: 200 });
  }) as unknown as typeof fetch;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('DEXSCREENER mode: eligible candidate -> BUY signal -> simulated paper order', () => {
  it('a fresh token meeting every entry rule produces a BUY decision and a FILLED paper order', async () => {
    const clock = new ManualClock(Date.now());
    const provider = new DexScreenerProvider({
      baseUrl: 'https://api.example.test',
      dexIds: ['pumpfun', 'pumpswap'],
      watchlist: [ELIGIBLE],
      maxTracked: 60,
      discoveryIntervalMs: 60_000,
      retryDelaysMs: [],
      clock: clock.now,
      fetchImpl: fakeFetch(() => [eligiblePair(clock.now())]),
    });
    ({ app } = await makeApp({ clock, provider }));

    // Before the bot runs, the pipeline explains why nothing is ordered.
    await app.services.market.refresh(true);
    let pipe = (await app.inject({ method: 'GET', url: '/api/strategy/pipeline' })).json() as StrategyPipelineSummary;
    expect(pipe).toMatchObject({ provider: 'dexscreener', simulated: false, observed: 1, fresh: 1, tradable: 1, entrySignals: 1, botRunning: false });
    expect(pipe.noOrderReason).toMatch(/bot is stopped/);

    const token = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json().items[0] as TokenView;
    expect(token).toMatchObject({ symbol: 'ELIG', tracked: true, tradable: true, entrySignal: 'BUY', sourceTimestamp: null });
    expect(token.fetchedAt).toBe(token.observedAt);
    expect(token.pairCreatedAt).not.toBe(token.fetchedAt); // pair creation is never used as the update time

    await app.services.bot.start();
    clock.advance(10_000); // provider minimum interval -> real (fake-HTTP) refetch
    await app.services.bot.tick(); // queue BUY (next-bar)

    expect(app.services.bot.pendingCount()).toBe(1);
    pipe = (await app.inject({ method: 'GET', url: '/api/strategy/pipeline' })).json();
    expect(pipe.lastCycle).toMatchObject({ buySignals: 1, submitted: 0, filled: 0, rejected: [] });
    expect(pipe.noOrderReason).toMatch(/queued for next-observation fill/);

    clock.advance(10_000); // newer observation -> fill
    await app.services.bot.tick();

    const buys = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=BUY' })).json().items as StrategyDecision[];
    expect(buys).toHaveLength(1);
    expect(buys[0].snapshot?.source).toBe('dexscreener');
    expect(buys[0].strategyChecks.every((c) => c.passed)).toBe(true);
    expect(buys[0].outcome).toMatch(/filled on next observation/);

    const trades = (await app.inject({ method: 'GET', url: '/api/trades' })).json().items as PaperOrder[];
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ status: 'FILLED', side: 'BUY', origin: 'bot', simulated: true, marketDataSource: 'dexscreener' });

    pipe = (await app.inject({ method: 'GET', url: '/api/strategy/pipeline' })).json();
    expect(pipe.lastCycle).toMatchObject({ submitted: 1, filled: 1, rejected: [] });
    expect(pipe.noOrderReason).toBeNull();
  });

  it('reports the first failing rule per candidate and explains why no order was submitted', async () => {
    const clock = new ManualClock(Date.now());
    const lowMomentum = mintN(1);
    const fewTxns = mintN(2);
    const provider = new DexScreenerProvider({
      baseUrl: 'https://api.example.test',
      dexIds: ['pumpswap'],
      watchlist: [lowMomentum, fewTxns],
      maxTracked: 60,
      discoveryIntervalMs: 60_000,
      retryDelaysMs: [],
      clock: clock.now,
      fetchImpl: fakeFetch(() => [
        eligiblePair(clock.now(), { baseToken: { address: lowMomentum, symbol: 'LOWM' }, priceChange: { m5: 1 } }),
        eligiblePair(clock.now(), { baseToken: { address: fewTxns, symbol: 'FEWTX' }, txns: { m5: { buys: 4, sells: 2 } } }),
      ]),
    });
    ({ app } = await makeApp({ clock, provider }));
    await app.services.bot.start();
    await app.services.bot.tick();
    const pipe = (await app.inject({ method: 'GET', url: '/api/strategy/pipeline' })).json() as StrategyPipelineSummary;
    expect(pipe.firstFailure).toEqual({ momentum_5m: 1, min_txns_5m: 1 });
    expect(pipe.entrySignals).toBe(0);
    expect(pipe.lastCycle).toMatchObject({ candidates: 2, buySignals: 0, submitted: 0 });
    expect(pipe.noOrderReason).toMatch(/No candidate currently passes every entry rule/);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);
  });

  it('price-impact rejections show the quote-vs-reserve component explicitly (threshold unchanged)', async () => {
    const clock = new ManualClock(Date.now());
    const provider = new DexScreenerProvider({
      baseUrl: 'https://api.example.test',
      dexIds: ['pumpswap'],
      watchlist: [ELIGIBLE],
      maxTracked: 60,
      discoveryIntervalMs: 60_000,
      retryDelaysMs: [],
      clock: clock.now,
      // Quoted price 12% above the reserve-implied price (still within the 15% data tolerance).
      fetchImpl: fakeFetch(() => [eligiblePair(clock.now(), { priceNative: String(1.12e-6) })]),
    });
    ({ app } = await makeApp({ clock, provider }));
    await app.services.market.refresh(true);
    const t = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json().items[0] as TokenView;
    expect(t.tradable).toBe(true);
    expect(t.entrySignal).toBe('SKIP');
    expect(t.entryFailures[0]).toMatch(/^max_price_impact: est\. .* = AMM\+buffer .*% \+ quote\/pool gap 12\.00% \(max 3%\)/);
  });
});

describe('tracked-set policy (discovery vs refresh)', () => {
  it('keeps held positions and tradable tokens refreshed while observation-only discoveries churn', async () => {
    const clock = new ManualClock(Date.now());
    let round = 0;
    const held = mintN(100);
    const reserveToken = mintN(101);
    // Every discovery round lists 6 brand-new bonding-curve tokens (no reserves).
    const discovery = () => Array.from({ length: 6 }, (_, i) => ({ chainId: 'solana', tokenAddress: mintN(200 + round * 6 + i) }));
    const requested: string[][] = [];
    const fetchImpl = fakeFetch(
      (mints) => {
        requested.push(mints);
        return mints.map((m) =>
          m === reserveToken || m === held
            ? eligiblePair(clock.now(), { baseToken: { address: m, symbol: m === held ? 'HELD' : 'RES' } })
            : eligiblePair(clock.now(), { baseToken: { address: m, symbol: 'CURVE' }, dexId: 'pumpfun', liquidity: undefined }),
        );
      },
      () => [{ chainId: 'solana', tokenAddress: reserveToken }, ...(round === 0 ? [{ chainId: 'solana', tokenAddress: held }] : []), ...discovery()],
    );
    const provider = new DexScreenerProvider({
      baseUrl: 'https://api.example.test',
      dexIds: ['pumpfun', 'pumpswap'],
      watchlist: [],
      maxTracked: 8,
      discoveryIntervalMs: 60_000,
      retryDelaysMs: [],
      clock: clock.now,
      fetchImpl,
    });
    await provider.poll();
    provider.setPinnedMints([held]);
    for (round = 1; round <= 5; round++) {
      clock.advance(60_000);
      await provider.poll();
    }
    const last = requested[requested.length - 1];
    expect(last).toContain(held); // pinned: always refreshed
    expect(last).toContain(reserveToken); // tradable tokens outlive observation-only churn
    expect(provider.isTracking(held)).toBe(true);
    expect(provider.isTracking(mintN(200))).toBe(false); // an old bonding-curve discovery was evicted
    expect(provider.trackedCount()).toBeLessThanOrEqual(9); // cap (8) + pinned
  });

  it('marks evicted tokens as untracked in the API instead of plain "stale", and records last-change time', async () => {
    const clock = new ManualClock(Date.now());
    let list = [{ chainId: 'solana', tokenAddress: ELIGIBLE }];
    const provider = new DexScreenerProvider({
      baseUrl: 'https://api.example.test',
      dexIds: ['pumpswap'],
      watchlist: [],
      maxTracked: 1,
      discoveryIntervalMs: 10_000,
      retryDelaysMs: [],
      clock: clock.now,
      fetchImpl: fakeFetch(
        // Observation-only (no reserves) so the newer discovery outranks it under the eviction policy.
        (mints) => mints.map((m) => eligiblePair(clock.now(), { baseToken: { address: m, symbol: m === ELIGIBLE ? 'ELIG' : 'OTHER' }, liquidity: undefined })),
        () => list,
      ),
    });
    ({ app } = await makeApp({ clock, provider }));
    await app.services.market.refresh(true);
    const firstFetch = clock.now();
    // Same data re-fetched later: lastChangedAt must not move.
    clock.advance(10_000);
    await app.services.market.refresh(true);
    let t = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json().items.find((x: TokenView) => x.symbol === 'ELIG');
    expect(t.lastChangedAt).toBe(firstFetch);
    expect(t.fetchedAt).toBe(clock.now());

    // A new discovery pushes ELIG out (cap 1); its last observation is labelled as no longer refreshed.
    list = [{ chainId: 'solana', tokenAddress: mintN(5) }];
    clock.advance(10_000);
    await app.services.market.refresh(true);
    t = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json().items.find((x: TokenView) => x.symbol === 'ELIG');
    expect(t.tracked).toBe(false);
    expect(t.tradable).toBe(false);
    expect(t.stale).toBe(false); // only 10s old: freshness alone would not reveal that it stopped refreshing
    expect(t.blockers.join(' ')).toMatch(/no longer refreshed/);
    const pipe = (await app.inject({ method: 'GET', url: '/api/strategy/pipeline' })).json() as StrategyPipelineSummary;
    expect(pipe.observed).toBe(2);
    expect(pipe.tracked).toBe(1);
  });
});
