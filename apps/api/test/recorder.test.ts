import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MarketObservationSchema } from '@spb/shared';
import { DexScreenerProvider } from '../src/market/dexscreenerProvider';
import { RecorderGuardError, assertNotTradingDb, openRecorderDb } from '../src/recorder/db';
import { MarketRecorder, pruneOlderThan } from '../src/recorder/recorder';
import { buildQualityReport, formatQualityReport } from '../src/recorder/report';
import { loadRecorderConfig } from '../src/recorder/config';
import { ManualClock, StaticProvider, makeObs, realObs } from './helpers';

/**
 * Side effects: every database lives in an OS temp directory created here; HTTP is faked
 * (fetchImpl); no network, no ports, nothing under apps/api/data is opened.
 */
const dir = mkdtempSync(join(tmpdir(), 'spb-recorder-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
let n = 0;
const tmpDb = (name = 'rec') => join(dir, `${name}-${n++}.db`);

const fixture = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-tokens.json', import.meta.url), 'utf8')) as Record<string, unknown>[];
const PUMPFUN = 'FjQYCiHM7VHFw4Syai5YCKZmy4vSPcDWmzNBuC8fpump';
const PUMPSWAP = '9uGqEsc5Sh9GBjvLr7jUf7PyY9tDZhiV7kCdyM7Wpump';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(handler: (url: string) => Reply) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void init;
    const r = handler(String(url));
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch & { mock: { calls: [string, RequestInit][] } };
}
const okFetch = () => fakeFetch((url) => (url.includes('/tokens/v1/') ? { status: 200, body: fixture } : { status: 200, body: [] }));

function dexProvider(clock: ManualClock, fetchImpl: typeof fetch) {
  return new DexScreenerProvider({
    baseUrl: 'https://api.example.test',
    dexIds: ['pumpfun', 'pumpswap'],
    watchlist: [PUMPFUN, PUMPSWAP],
    maxTracked: 60,
    discoveryIntervalMs: 60_000,
    retryDelaysMs: [0, 0],
    clock: clock.now,
    fetchImpl,
  });
}
function recorder(db: Database.Database, provider: ConstructorParameters<typeof MarketRecorder>[0]['provider'], clock: ManualClock, intervalMs = 15_000) {
  return new MarketRecorder({ db, provider, clock: clock.now, intervalMs, retentionDays: 30, runConfig: { test: true } });
}
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('database isolation', () => {
  function tradingDb() {
    const file = tmpDb('paper');
    const t = new Database(file);
    t.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, payload TEXT); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);');
    t.prepare('INSERT INTO orders VALUES (?, ?)').run('o1', '{"side":"BUY"}');
    t.close();
    return file;
  }

  it('refuses to open the trading database (same, relative or differently-cased path)', () => {
    const paper = tradingDb();
    expect(() => openRecorderDb(paper, paper)).toThrow(RecorderGuardError);
    expect(() => openRecorderDb(relative(process.cwd(), paper), paper)).toThrow(/resolves to the trading database/);
    if (process.platform === 'win32') expect(() => openRecorderDb(paper.toUpperCase(), paper)).toThrow(RecorderGuardError);
  });

  it('refuses any existing file that contains trading tables', () => {
    const paper = tradingDb();
    expect(() => assertNotTradingDb(paper, null)).toThrow(/contains trading tables \(orders, kv\)/);
  });

  it('config refuses a non-file recorder URL and derives the trading path from DATABASE_URL', () => {
    expect(() => loadRecorderConfig({ RECORDER_DATABASE_URL: 'sqlite::memory:' })).toThrow(/file-based sqlite/);
    expect(() => loadRecorderConfig({ RECORDER_POLL_INTERVAL_MS: '5000' })).toThrow();
    const cfg = loadRecorderConfig({ DATABASE_URL: 'sqlite:./data/paper.db' });
    expect(cfg.dbPath).toMatch(/recordings\.db$/);
    expect(cfg.tradingDbPath).toMatch(/paper\.db$/);
    expect(cfg.intervalMs).toBe(15_000);
  });

  it('records into its own file and leaves the trading database byte-for-byte unchanged', async () => {
    const paper = tradingDb();
    const before = { hash: sha(paper), mtime: statSync(paper).mtimeMs };
    const recFile = tmpDb();
    const db = openRecorderDb(recFile, paper);
    const clock = new ManualClock(Date.now());
    const rec = recorder(db, dexProvider(clock, okFetch()), clock);
    for (let i = 0; i < 3; i++) {
      await rec.pollOnce();
      clock.advance(15_000);
    }
    await rec.stop('test');
    expect((db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number }).c).toBe(6);
    db.close();
    expect(sha(paper)).toBe(before.hash);
    expect(statSync(paper).mtimeMs).toBe(before.mtime);
  });
});

describe('what is recorded', () => {
  it('stores identifiers, prices, liquidity, volume, txns and the distinct timestamps', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const fetchImpl = okFetch();
    const rec = recorder(db, dexProvider(clock, fetchImpl), clock);
    const out = await rec.pollOnce();
    expect(out).toMatchObject({ status: 'ok', observations: 2, duplicates: 0, rejected: 0 });
    const rows = db.prepare('SELECT * FROM observations ORDER BY mint').all() as Record<string, unknown>[];
    const pf = rows.find((r) => r.mint === PUMPFUN)!;
    const ps = rows.find((r) => r.mint === PUMPSWAP)!;
    const fxPs = fixture[1] as { pairCreatedAt: number; pairAddress: string; liquidity: { quote: number; base: number } };
    expect(ps).toMatchObject({ dex_id: 'pumpswap', pair_address: fxPs.pairAddress, pair_created_at: fxPs.pairCreatedAt, source_ts: null });
    expect(ps.fetched_at).toBe(clock.now());
    expect(ps.poll_started_at).toBe(clock.now());
    expect(ps.pair_created_at).not.toBe(ps.fetched_at);
    expect(ps.quote_reserve_sol).toBeCloseTo(fxPs.liquidity.quote, 6);
    expect(ps.base_reserve).toBeCloseTo(fxPs.liquidity.base, 0);
    expect(typeof ps.volume_5m_sol).toBe('number');
    expect(typeof ps.buys_5m).toBe('number');
    // Unavailable reserves on bonding-curve pairs are NULL, never zero.
    expect(pf.quote_reserve_sol).toBeNull();
    expect(pf.base_reserve).toBeNull();
    const payload = MarketObservationSchema.parse(JSON.parse(ps.payload_json as string));
    expect(payload).toMatchObject({ source: 'dexscreener', simulated: false });
    // Only GET requests, only to documented paths.
    for (const [url, init] of (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls) {
      expect(init.method).toBe('GET');
      expect(url).toMatch(/\/(token-profiles\/latest\/v1|token-boosts\/(latest|top)\/v1|community-takeovers\/latest\/v1|latest\/dex\/search\?q=|tokens\/v1\/solana\/)/);
    }
    db.close();
  });

  it('fetch timestamps are monotonic per token across polls', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const rec = recorder(db, dexProvider(clock, okFetch()), clock);
    for (let i = 0; i < 4; i++) {
      await rec.pollOnce();
      clock.advance(15_000);
    }
    const ts = (db.prepare('SELECT fetched_at FROM observations WHERE mint = ? ORDER BY id').all(PUMPSWAP) as { fetched_at: number }[]).map((r) => r.fetched_at);
    expect(ts).toHaveLength(4);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBe(ts[i - 1] + 15_000);
    db.close();
  });
});

describe('duplicates, ordering and data validity', () => {
  it('a provider cache hit records a "cached" poll and no rows', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const rec = recorder(db, dexProvider(clock, okFetch()), clock);
    await rec.pollOnce();
    clock.advance(3_000); // faster than the provider's 10 s minimum -> cached response
    const out = await rec.pollOnce();
    expect(out.status).toBe('cached');
    expect((db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('ignores duplicate (mint, fetched_at) rows and rejects out-of-order observations', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const provider = new StaticProvider('dexscreener');
    provider.observations = [realObs(clock.now())];
    const rec = recorder(db, provider, clock);
    expect((await rec.pollOnce()).observations).toBe(1);
    expect((await rec.pollOnce()).duplicates).toBe(1);
    provider.observations = [realObs(clock.now() - 60_000)];
    const out = await rec.pollOnce();
    expect(out.rejected).toBe(1);
    const reasons = (db.prepare('SELECT reason FROM rejections').all() as { reason: string }[]).map((r) => r.reason);
    expect(reasons[0]).toMatch(/^out-of-order/);
    expect((db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('never stores simulated data as real observations', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const mock = new StaticProvider('mock');
    mock.observations = [makeObs(clock.now())];
    const out = await recorder(db, mock, clock).pollOnce();
    expect(out).toMatchObject({ observations: 0, rejected: 1 });
    expect((db.prepare('SELECT reason FROM rejections').get() as { reason: string }).reason).toMatch(/not real DexScreener data/);
    db.close();
  });

  it('rejects schema-invalid and future-dated observations', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const provider = new StaticProvider('dexscreener');
    provider.observations = [
      realObs(clock.now(), { pairCreatedAt: clock.now() + 3_600_000 }), // future pair creation -> schema
      realObs(clock.now() + 60_000, { mint: 'FjQYCiHM7VHFw4Syai5YCKZmy4vSPcDWmzNBuC8fpump' }), // fetched "in the future"
      { garbage: true },
    ];
    const out = await recorder(db, provider, clock).pollOnce();
    expect(out).toMatchObject({ observations: 0, rejected: 3 });
    const reasons = (db.prepare('SELECT reason FROM rejections ORDER BY id').all() as { reason: string }[]).map((r) => r.reason.split(':')[0]);
    expect(reasons.sort()).toEqual(['fetch timestamp in the future', 'schema', 'schema']);
    db.close();
  });
});

describe('errors, rate limits and gaps', () => {
  it('HTTP 429: records a failed poll and waits at least Retry-After before the next poll', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const rec = recorder(db, dexProvider(clock, fakeFetch(() => ({ status: 429, headers: { 'retry-after': '40' } }))), clock);
    const out = await rec.pollOnce();
    expect(out.status).toBe('failed');
    expect(out.nextDelayMs).toBeGreaterThanOrEqual(40_000);
    const poll = db.prepare('SELECT status, error, rate_limited_until FROM polls').get() as { status: string; error: string; rate_limited_until: number | null };
    expect(poll.status).toBe('failed');
    expect(poll.error).toMatch(/429|rate-limited/);
    expect(poll.rate_limited_until).toBe(clock.now() + 40_000);
    db.close();
  });

  it('transient failures back off exponentially, then a success resets and records the gap', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    let fail = false;
    const fetchImpl = fakeFetch((url) => (fail ? { status: 503 } : url.includes('/tokens/v1/') ? { status: 200, body: fixture } : { status: 200, body: [] }));
    const rec = recorder(db, dexProvider(clock, fetchImpl), clock);
    expect((await rec.pollOnce()).status).toBe('ok');
    fail = true;
    clock.advance(15_000);
    const f1 = await rec.pollOnce();
    clock.advance(f1.nextDelayMs);
    const f2 = await rec.pollOnce();
    expect(f1.nextDelayMs).toBe(30_000);
    expect(f2.nextDelayMs).toBe(60_000);
    fail = false;
    clock.advance(f2.nextDelayMs);
    expect((await rec.pollOnce()).status).toBe('ok');
    const gap = db.prepare('SELECT kind, from_ts, to_ts FROM gaps').get() as { kind: string; from_ts: number; to_ts: number };
    expect(gap.kind).toBe('poll_gap');
    expect(gap.to_ts - gap.from_ts).toBe(15_000 + 30_000 + 60_000);
    db.close();
  });

  it('records a monitoring gap within a run (e.g. sleep) and between runs', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const rec = recorder(db, dexProvider(clock, okFetch()), clock);
    await rec.pollOnce();
    clock.advance(10 * 60_000);
    await rec.pollOnce();
    await rec.stop('test');
    clock.advance(30 * 60_000);
    const rec2 = recorder(db, dexProvider(clock, okFetch()), clock);
    await rec2.pollOnce();
    const gaps = db.prepare('SELECT kind, to_ts - from_ts AS ms FROM gaps ORDER BY id').all() as { kind: string; ms: number }[];
    expect(gaps).toEqual([
      { kind: 'poll_gap', ms: 10 * 60_000 },
      { kind: 'between_runs', ms: 30 * 60_000 },
    ]);
    db.close();
  });
});

describe('lifecycle and retention', () => {
  it('start() polls on its own; stop() ends the loop and marks the run as cleanly stopped', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const provider = new StaticProvider('dexscreener');
    provider.observations = [realObs(Date.now())];
    const rec = new MarketRecorder({ db, provider, clock: Date.now, intervalMs: 20, retentionDays: 30, runConfig: {} });
    rec.start();
    await new Promise((r) => setTimeout(r, 200));
    await rec.stop('test-stop');
    await rec.stop('again'); // idempotent
    const polls = (db.prepare('SELECT COUNT(*) AS c FROM polls').get() as { c: number }).c;
    await new Promise((r) => setTimeout(r, 80));
    expect((db.prepare('SELECT COUNT(*) AS c FROM polls').get() as { c: number }).c).toBe(polls); // no polls after stop
    expect(polls).toBeGreaterThanOrEqual(3);
    const run = db.prepare('SELECT stopped_at, stop_reason FROM recorder_runs').get() as { stopped_at: number | null; stop_reason: string };
    expect(run.stopped_at).not.toBeNull();
    expect(run.stop_reason).toBe('test-stop');
    db.close();
  });

  it('retention removes only rows older than the cutoff', async () => {
    const db = openRecorderDb(tmpDb(), null);
    const clock = new ManualClock(Date.now());
    const rec = recorder(db, dexProvider(clock, okFetch()), clock);
    await rec.pollOnce();
    const cutoff = clock.now() + 1;
    clock.advance(15_000);
    await rec.pollOnce();
    const removed = pruneOlderThan(db, cutoff);
    expect(removed.observations).toBe(2);
    expect((db.prepare('SELECT MIN(fetched_at) AS t FROM observations').get() as { t: number }).t).toBe(clock.now());
    db.close();
  });
});

describe('quality report', () => {
  it('summarises cadence, gaps, duplicates, missing values and quote/pool gaps from recorded rows only', async () => {
    const file = tmpDb();
    const db = openRecorderDb(file, null);
    const clock = new ManualClock(Date.now());
    const rec = recorder(db, dexProvider(clock, okFetch()), clock);
    for (let i = 0; i < 4; i++) {
      await rec.pollOnce();
      clock.advance(15_000);
    }
    clock.advance(5 * 60_000); // gap
    await rec.pollOnce();
    await rec.stop('test');
    db.close();

    const ro = new Database(file, { readonly: true, fileMustExist: true });
    const r = buildQualityReport(ro, clock.now());
    ro.close();
    expect(r.intervalMs).toBe(15_000);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0].cleanStop).toBe(true);
    expect(r.polls).toMatchObject({ total: 5, ok: 5, failed: 0 });
    expect(r.polls.intervalMs.median).toBe(15_000);
    expect(r.gaps.count).toBe(1);
    expect(r.observations).toMatchObject({ total: 10, tokens: 2 });
    expect(r.missingValuesPct.quote_reserve_sol).toBe(50); // bonding-curve pair has no reserves
    expect(r.missingValuesPct.price_sol).toBe(0);
    expect(r.quotePoolGap.withReservesPct).toBe(50);
    expect(r.quotePoolGap.median!).toBeGreaterThan(10); // fixture quote is ~13% above pool-implied
    expect(r.quotePoolGap.within15Pct).toBe(100);
    expect(r.unchangedConsecutivePct).toBe(100); // same fixture each poll: flagged, not hidden
    expect(r.notes.join(' ')).toMatch(/NOT contiguous across recorded gaps/);
    const text = formatQualityReport(r);
    expect(text).toMatch(/Recording quality report/);
    expect(text).toMatch(/gaps: 1/);
  });
});
