import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { BorshDecoder, BorshReader, type DecodedValue, type IdlType } from '../src/onchain/borsh';
import { UsageBudget } from '../src/onchain/budget';
import { openOnchainDb, readSchemaVersion } from '../src/onchain/db';
import { withApiKey } from '../src/onchain/helius';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, loadPinnedDecoder } from '../src/onchain/idl';
import { OnchainRecorder } from '../src/onchain/recorder';
import { buildOnchainReport, formatOnchainReport } from '../src/onchain/report';
import { openRecorderDb } from '../src/recorder/db';
import { ManualClock } from './helpers';
import { FakeRpc, FakeWs, encodeValue, ixLogs, synthAddress, synthEvent, synthSignature } from './onchain-fixtures';

/**
 * ALL FIXTURES ARE SYNTHETIC (see onchain-fixtures.ts). Side effects: databases in an OS temp
 * directory; WebSocket/RPC are fakes; the test-wide network guard blocks non-loopback traffic; the
 * one child process (CLI default check) inherits that guard. Nothing under apps/api/data is opened.
 */
const dir = mkdtempSync(join(tmpdir(), 'spb-onchain-cov-'));
const opened: Database.Database[] = [];
afterAll(() => {
  for (const d of opened) if (d.open) d.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
let n = 0;
const tmpDb = () => join(dir, `cov-${n++}.db`);
const openDb = (file = tmpDb()) => {
  const d = openOnchainDb(file, null, 1);
  opened.push(d);
  return d;
};
const decoder = loadPinnedDecoder();
const KEY = 'synthetic-coverage-key-9f8e7d';
const LIMITS = { dailyCredits: 100_000, monthlyCredits: 1_000_000, dailyBytes: 500_000_000 };
const MODEL = { creditsPerRpcCall: 1, wsCreditsPer100Kb: 2, wsCreditsPerConnection: 1 };
const mint = (l: string) => synthAddress(`cov-mint-${l}`);
const A = mint('a');
const B = mint('b');
const C = mint('c');

interface Period {
  mint: string;
  started_at: number;
  last_alive_at: number;
  ended_at: number | null;
  end_reason: string | null;
}
interface Coverage {
  mint: string;
  started_at: number;
  covered_until: number | null;
  end_kind: string;
}

function setup(over: { subscriptions?: string[]; limits?: typeof LIMITS; db?: Database.Database; clock?: ManualClock } = {}) {
  const db = over.db ?? openDb();
  const clock = over.clock ?? new ManualClock();
  const budget = new UsageBudget(db, over.limits ?? LIMITS, MODEL, clock.now);
  const sockets: FakeWs[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const logs: string[] = [];
  const rpc = new FakeRpc();
  const rec = new OnchainRecorder({
    db,
    decoder,
    budget,
    rpc,
    wsFactory: (url) => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws;
    },
    wsUrl: withApiKey('wss://ws.example.test/', KEY),
    apiKey: KEY,
    subscriptions: over.subscriptions ?? [A],
    clock: clock.now,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    random: () => 1,
    log: (m) => logs.push(m),
    backfillMaxSignatures: 10,
    backfillOnStart: true,
    storeRaw: 'all',
    maxTxVersion: 1,
    keepalive: { intervalMs: 60_000, staleAfterMs: 150_000 },
    runConfig: { synthetic: true },
  });
  const run = (ms: number) => {
    const t = timers.find((x) => !x.cancelled && x.ms === ms);
    if (!t) throw new Error(`no pending timer of ${ms} ms`);
    t.cancelled = true;
    t.fn();
  };
  const ws = () => sockets[sockets.length - 1]!;
  const periods = (m?: string) =>
    (m
      ? db.prepare('SELECT mint, started_at, last_alive_at, ended_at, end_reason FROM onchain_subscription_periods WHERE mint = ? ORDER BY id').all(m)
      : db.prepare('SELECT mint, started_at, last_alive_at, ended_at, end_reason FROM onchain_subscription_periods ORDER BY id').all()) as Period[];
  const coverage = (m: string) =>
    db.prepare('SELECT mint, started_at, covered_until, end_kind FROM onchain_coverage WHERE mint = ? ORDER BY started_at').all(m) as Coverage[];
  return { db, clock, budget, sockets, timers, logs, rpc, rec, run, ws, periods, coverage };
}
const sent = (ws: FakeWs, method: string) => ws.sent.filter((s) => s.method === method);
const trade = (m: string, over: Record<string, DecodedValue> = {}) => ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent', { mint: m, ...over }).payload]);

// ------------------------------------------------------------------ subscription coverage periods

describe('subscription coverage periods', () => {
  it('opens a period only when the server confirms the subscription, at the confirmation time', () => {
    const s = setup({ subscriptions: [A, B] });
    s.rec.start();
    s.clock.advance(5_000);
    s.ws().open();
    expect(s.periods()).toEqual([]); // requested but not confirmed: not covered
    s.clock.advance(2_000);
    s.ws().confirmAll();
    const t = s.clock.now();
    expect(s.periods()).toEqual([
      { mint: A, started_at: t, last_alive_at: t, ended_at: null, end_reason: null },
      { mint: B, started_at: t, last_alive_at: t, ended_at: null, end_reason: null },
    ]);
    expect(s.coverage(A)[0]!.end_kind).toBe('active');
  });

  it('a lost connection ends periods; coverage stops at the last message received, not at detection', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.clock.advance(10_000);
    s.ws().notify(subs.get(A)!, synthSignature('cov-1'), 1, trade(A));
    const lastMsg = s.clock.now();
    s.clock.advance(100_000);
    s.ws().serverDrop();
    const detected = s.clock.now();
    expect(s.periods(A)).toEqual([expect.objectContaining({ ended_at: detected, end_reason: 'disconnect', last_alive_at: lastMsg })]);
    expect(s.coverage(A)).toEqual([expect.objectContaining({ covered_until: lastMsg, end_kind: 'lost' })]);
    expect(s.db.prepare('SELECT from_ts FROM onchain_gaps WHERE subscription = ?').get(A)).toEqual({ from_ts: lastMsg });
  });

  it('a stale connection ends periods with reason stale; coverage stops at the last inbound message', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    const confirmedAt = s.clock.now();
    for (let i = 0; i < 3; i++) {
      s.clock.advance(60_000);
      s.run(60_000); // pings go out unanswered
    }
    expect(s.periods(A)).toEqual([expect.objectContaining({ end_reason: 'stale', ended_at: confirmedAt + 180_000, last_alive_at: confirmedAt })]);
    expect(s.coverage(A)[0]).toMatchObject({ covered_until: confirmedAt, end_kind: 'lost' });
  });

  it('reconnects open a new period per restored subscription; removed mints are not restored', () => {
    const s = setup({ subscriptions: [A, B] });
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    s.rec.addSubscription(C);
    const req = sent(s.ws(), 'logsSubscribe').at(-1)!;
    s.ws().msg({ jsonrpc: '2.0', id: req.id, result: 999 });
    s.rec.removeSubscription(B);
    s.ws().serverDrop();
    s.run(1_000);
    s.ws().open();
    expect(sent(s.ws(), 'logsSubscribe').map((r) => (r.params[0] as { mentions: string[] }).mentions[0])).toEqual([A, C]);
    s.ws().confirmAll(300);
    expect(s.periods(A).map((p) => p.end_reason)).toEqual(['disconnect', null]);
    expect(s.periods(B).map((p) => p.end_reason)).toEqual(['unsubscribed']);
    expect(s.periods(C).map((p) => p.end_reason)).toEqual(['disconnect', null]);
  });

  it('never claims coverage across the disconnected interval', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.clock.advance(20_000);
    s.ws().notify(subs.get(A)!, synthSignature('cov-2'), 1, trade(A));
    const lastMsg = s.clock.now();
    s.clock.advance(40_000);
    s.ws().serverDrop();
    s.clock.advance(30_000);
    s.run(1_000);
    s.ws().open();
    s.clock.advance(1_000);
    s.ws().confirmAll(50);
    const reconfirmed = s.clock.now();
    const cov = s.coverage(A);
    expect(cov).toHaveLength(2);
    expect(cov[0]!.covered_until).toBe(lastMsg);
    expect(cov[1]!.started_at).toBe(reconfirmed);
    // no period covers any instant in (lastMsg, reconfirmed)
    const probe = lastMsg + 1;
    expect(cov.some((c) => c.started_at <= probe && (c.covered_until === null || c.covered_until >= probe) && c.end_kind !== 'active')).toBe(false);
    expect(cov.filter((c) => c.end_kind === 'active').every((c) => c.started_at > probe)).toBe(true);
  });

  it('a budget pause ends periods cleanly; mints added while paused get a period only after resuming', () => {
    const s = setup({ limits: { ...LIMITS, dailyBytes: 1_500 } });
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.clock.advance(5_000);
    s.ws().notify(subs.get(A)!, synthSignature('big'), 1, ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent').payload, synthEvent('pump', 'TradeEvent').payload]));
    const pausedAt = s.clock.now();
    expect(s.rec.status).toBe('paused_budget');
    expect(s.periods(A)).toEqual([expect.objectContaining({ end_reason: 'budget_pause', ended_at: pausedAt })]);
    expect(s.coverage(A)[0]).toMatchObject({ covered_until: pausedAt, end_kind: 'clean' });
    s.rec.addSubscription(C);
    expect(s.periods(C)).toEqual([]);
    const resume = s.timers.find((t) => !t.cancelled && t.ms > 60_000)!;
    s.clock.advance(resume.ms);
    resume.cancelled = true;
    resume.fn();
    s.ws().open();
    s.ws().confirmAll(70);
    expect(s.periods(C)).toEqual([expect.objectContaining({ started_at: s.clock.now(), end_reason: null })]);
    expect(s.periods(A)).toHaveLength(2);
  });

  it('unsubscribe ends only that mint; re-adding opens a fresh period', () => {
    const s = setup({ subscriptions: [A, B] });
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    s.clock.advance(1_000);
    s.rec.removeSubscription(B);
    expect(s.periods(B)).toEqual([expect.objectContaining({ end_reason: 'unsubscribed', ended_at: s.clock.now() })]);
    expect(s.periods(A)[0]!.end_reason).toBeNull();
    s.clock.advance(60_000);
    s.rec.addSubscription(B);
    s.ws().msg({ jsonrpc: '2.0', id: sent(s.ws(), 'logsSubscribe').at(-1)!.id, result: 4242 });
    expect(s.periods(B).map((p) => [p.end_reason, p.started_at])).toEqual([
      ['unsubscribed', s.clock.now() - 61_000],
      [null, s.clock.now()],
    ]);
  });

  it('a rejected resubscription ends the other periods with reason subscribe_failed', () => {
    const s = setup({ subscriptions: [A, B] });
    s.rec.start();
    s.ws().open();
    s.ws().msg({ jsonrpc: '2.0', id: 1, result: 10 });
    s.ws().msg({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'synthetic rejection' } });
    expect(s.periods()).toEqual([expect.objectContaining({ mint: A, end_reason: 'subscribe_failed' })]);
  });

  it('a clean stop ends every period as session_stopped and records the session proof of life', async () => {
    const s = setup({ subscriptions: [A, B] });
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.clock.advance(45_000);
    s.ws().notify(subs.get(A)!, synthSignature('cov-3'), 1, []);
    const lastMsg = s.clock.now();
    s.clock.advance(5_000);
    await s.rec.stop('test');
    expect(s.periods().map((p) => p.end_reason)).toEqual(['session_stopped', 'session_stopped']);
    expect(s.db.prepare('SELECT stop_reason, stopped_at, last_alive_at FROM onchain_sessions').get()).toEqual({ stop_reason: 'test', stopped_at: s.clock.now(), last_alive_at: lastMsg });
  });

  it('a crashed session is detected by the next one: end unknown, coverage only to the last persisted proof of life', () => {
    const file = tmpDb();
    const db = openDb(file);
    const clock = new ManualClock();
    const first = setup({ db, clock, subscriptions: [A] });
    first.rec.start();
    first.ws().open();
    const subs = first.ws().confirmAll();
    clock.advance(40_000);
    first.ws().notify(subs.get(A)!, synthSignature('cov-4'), 1, []); // persisted (>= 30 s since last write)
    const proof = clock.now();
    clock.advance(10_000);
    first.ws().notify(subs.get(A)!, synthSignature('cov-5'), 2, []); // within 30 s: not persisted
    // process "dies" here: no stop()
    clock.advance(3_600_000);
    const second = setup({ db, clock, subscriptions: [A] });
    second.rec.start();
    const p = db.prepare('SELECT session_id, ended_at, end_reason, last_alive_at FROM onchain_subscription_periods WHERE session_id = ?').get(first.rec.sessionId);
    expect(p).toEqual({ session_id: first.rec.sessionId, ended_at: null, end_reason: 'session_crashed', last_alive_at: proof });
    expect(db.prepare('SELECT covered_until, end_kind FROM onchain_coverage WHERE session_id = ?').get(first.rec.sessionId)).toEqual({ covered_until: proof, end_kind: 'end_unknown' });
    expect(db.prepare('SELECT stopped_at, stop_reason, last_alive_at FROM onchain_sessions WHERE id = ?').get(first.rec.sessionId)).toEqual({
      stopped_at: null,
      stop_reason: 'crashed_or_killed',
      last_alive_at: proof,
    });
  });

  it('persists proof of life at most every 30 s', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    const t0 = s.clock.now();
    const alive = () => s.periods(A)[0]!.last_alive_at;
    const at = (dt: number) => {
      s.clock.advance(dt);
      s.ws().notify(subs.get(A)!, synthSignature(`hb-${s.clock.now()}`), 1, []);
    };
    at(10_000);
    expect(alive()).toBe(t0 + 10_000); // first write
    at(10_000);
    at(15_000);
    expect(alive()).toBe(t0 + 10_000); // 25 s since the last write: throttled
    at(6_000);
    expect(alive()).toBe(t0 + 41_000);
  });

  it('the report summarises coverage by end kind', async () => {
    const file = tmpDb();
    const s = setup({ db: openDb(file) });
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    s.clock.advance(60_000);
    s.ws().serverDrop();
    const ro = new Database(file, { readonly: true });
    const r = buildOnchainReport(ro, s.clock.now());
    ro.close();
    expect(r.coverage).toEqual([{ end_kind: 'lost', periods: 1, mints: 1, covered_ms: 0 }]); // nothing received after confirmation
    expect(formatOnchainReport(r)).toMatch(/Subscription coverage/);
  });
});

// ------------------------------------------------------------------ keepalive (deterministic)

describe('keepalive and connection health', () => {
  it('sends no ping before the socket opens, and none after stop', async () => {
    const s = setup();
    s.rec.start();
    expect(s.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([30_000]); // connect timeout only
    s.ws().open();
    s.ws().confirmAll();
    await s.rec.stop('test');
    expect(s.timers.filter((t) => !t.cancelled && t.ms === 60_000)).toHaveLength(0);
    expect(sent(s.ws(), 'ping')).toHaveLength(0);
  });

  it('missed ping replies alone do not drop a connection that still delivers notifications', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    for (let i = 0; i < 6; i++) {
      s.clock.advance(60_000);
      s.run(60_000); // ping, never answered
      s.ws().notify(subs.get(A)!, synthSignature(`traffic-${i}`), i + 1, []);
    }
    expect(sent(s.ws(), 'ping')).toHaveLength(6);
    expect(s.sockets).toHaveLength(1);
    expect(s.rec.status).toBe('live');
  });

  it('a silent connection stays up until the stale limit, then is replaced and fully restored', () => {
    const s = setup({ subscriptions: [A, B] });
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    s.clock.advance(60_000);
    s.run(60_000);
    s.clock.advance(60_000);
    s.run(60_000); // 120 s silent < 150 s
    expect(s.rec.status).toBe('live');
    expect(s.sockets).toHaveLength(1);
    s.clock.advance(60_000);
    s.run(60_000); // 180 s silent > 150 s
    expect(s.rec.status).toBe('reconnecting');
    expect(s.sockets[0]!.closed).toMatchObject({ code: 4002 });
    s.run(1_000);
    s.ws().open();
    expect(sent(s.ws(), 'logsSubscribe')).toHaveLength(2);
    s.ws().confirmAll(500);
    expect(s.rec.status).toBe('live');
    s.clock.advance(60_000);
    s.run(60_000);
    expect(sent(s.ws(), 'ping')).toHaveLength(1); // keepalive restarted on the new socket
    expect(sent(s.sockets[0]!, 'ping')).toHaveLength(2); // and never again on the old one
  });
});

// ------------------------------------------------------------------ data integrity

describe('exact integers and decoding boundaries', () => {
  const cases: [IdlType, DecodedValue][] = [
    ['u8', 0], ['u8', 255], ['i8', -128], ['i8', 127],
    ['u16', 65_535], ['i16', -32_768], ['u32', 4_294_967_295], ['i32', -2_147_483_648], ['i32', 2_147_483_647],
    ['u64', '0'], ['u64', '9007199254740993'], ['u64', '18446744073709551615'],
    ['i64', '-9223372036854775808'], ['i64', '9223372036854775807'], ['i64', '-1'],
    ['u128', '340282366920938463463374607431768211455'],
    ['i128', '-170141183460469231731687303715884105728'], ['i128', '170141183460469231731687303715884105727'], ['i128', '-1'],
    ['bool', true], ['bool', false], ['string', ''], ['string', 'é✓🚀'],
    [{ vec: 'u64' }, []], [{ vec: 'u64' }, ['18446744073709551615', '1']], [{ option: 'u64' }, null], [{ option: 'u64' }, '42'],
    [{ array: ['u16', 3] }, [0, 1, 65_535]],
  ];
  it.each(cases)('round-trips %j value %j exactly and consumes every byte', (type, value) => {
    const bytes: number[] = [];
    encodeValue(new Map(), type, value, bytes);
    const r = new BorshReader(Uint8Array.from(bytes));
    expect(new BorshDecoder([]).decode(type, r, 'v')).toEqual(value);
    expect(r.remaining).toBe(0);
  });

  it('fails visibly one byte short of every fixed-width integer', () => {
    for (const [type, size] of [['u16', 2], ['u32', 4], ['u64', 8], ['i64', 8], ['u128', 16], ['i128', 16]] as const) {
      expect(() => new BorshDecoder([]).decode(type, new BorshReader(new Uint8Array(size - 1)), 'v')).toThrow(/Need/);
    }
  });

  it('stores extreme amounts as exact TEXT in SQLite and in fields_json (no float conversion anywhere)', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    const MAX = '18446744073709551615';
    s.ws().notify(
      subs.get(A)!,
      synthSignature('max'),
      1,
      ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent', { mint: A, token_amount: MAX, quote_amount: '9007199254740993', virtual_quote_reserves: MAX, real_quote_reserves: MAX }).payload]),
    );
    s.ws().notify(subs.get(A)!, synthSignature('i128'), 2, ixLogs(PUMP_AMM_PROGRAM_ID, [synthEvent('pump_amm', 'BuyEvent', { virtual_quote_reserves: '-170141183460469231731687303715884105728' }).payload]));
    const row = s.db
      .prepare('SELECT base_amount, typeof(base_amount) AS t1, quote_amount, typeof(quote_amount) AS t2, reserve_quote_virtual, typeof(reserve_quote_virtual) AS t3, fields_json FROM chain_events WHERE signature = ?')
      .get(synthSignature('max')) as Record<string, string>;
    expect(row).toMatchObject({ base_amount: MAX, t1: 'text', quote_amount: '9007199254740993', t2: 'text', reserve_quote_virtual: MAX, t3: 'text' });
    expect(JSON.parse(row.fields_json!).token_amount).toBe(MAX);
    expect(row.fields_json).not.toMatch(/[:[,]\s*-?\d{16,}/); // big integers never serialized as JSON numbers
    expect(s.db.prepare('SELECT reserve_quote_virtual AS v, typeof(reserve_quote_virtual) AS t FROM chain_events WHERE signature = ?').get(synthSignature('i128'))).toEqual({
      v: '-170141183460469231731687303715884105728',
      t: 'text',
    });
  });

  it('keeps v1 rows and v2 rows intact when the database is reopened (migration is idempotent and additive)', () => {
    const file = tmpDb();
    const v1 = openRecorderDb(file, null);
    v1.prepare("INSERT INTO recorder_runs (id, started_at, version, config_json) VALUES ('r1', 1, '0', '{}')").run();
    v1.prepare("INSERT INTO observations (run_id, poll_id, mint, fetched_at, poll_started_at, payload_json) VALUES ('r1', 'p1', 'm', 1, 1, '{}')").run();
    v1.close();
    const s = setup({ db: openDb(file) });
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    s.db.close();
    const again = openDb(file);
    expect(readSchemaVersion(again)).toBe(2);
    expect(again.prepare('SELECT (SELECT COUNT(*) FROM observations) AS o, (SELECT COUNT(*) FROM recorder_runs) AS r, (SELECT COUNT(*) FROM onchain_subscription_periods) AS p').get()).toEqual({ o: 1, r: 1, p: 1 });
  });
});

// ------------------------------------------------------------------ safety

describe('safety', () => {
  it('never stores the API key in any table, even when errors and close reasons contain it', async () => {
    const s = setup({ subscriptions: [A, B] });
    s.rpc.accountError = new Error(`upstream said https://rpc.example.test/?api-key=${KEY} failed (${KEY})`);
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.ws().notify(subs.get(A)!, synthSignature('amm'), 1, ixLogs(PUMP_AMM_PROGRAM_ID, [synthEvent('pump_amm', 'BuyEvent', { pool: synthAddress('leaky-pool') }).payload]));
    await s.rec.idle();
    s.ws().onclose?.({ code: 1011, reason: `server error api-key=${KEY}` });
    s.run(1_000);
    s.ws().onerror?.({ message: `connect failed for wss://x/?api-key=${KEY}` });
    await s.rec.stop('test');
    const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) expect(JSON.stringify(s.db.prepare(`SELECT * FROM "${t}"`).all()), t).not.toContain(KEY);
    expect(s.logs.join('\n')).not.toContain(KEY);
    expect((s.db.prepare("SELECT detail FROM onchain_pools WHERE pool = ?").get(synthAddress('leaky-pool')) as { detail: string }).detail).toMatch(/api-key=\*\*\*/);
  });

  it('the default CLI command is a local check: exit 0, no database created, key never printed', async () => {
    const recFile = join(dir, 'never-created.db');
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/onchain/cli.ts'], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: `sqlite:${join(dir, 'paper-placeholder.db')}`, RECORDER_DATABASE_URL: `sqlite:${recFile}`, HELIUS_API_KEY: KEY },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, text });
      });
    });
    expect(out.code, out.text).toBe(0);
    expect(out.text).toMatch(/no database was opened/);
    expect(out.text).not.toContain(KEY);
    expect(existsSync(recFile)).toBe(false);
  }, 90_000);
});
