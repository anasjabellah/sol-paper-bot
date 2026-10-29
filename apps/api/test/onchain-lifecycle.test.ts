import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { decodeBase58, encodeBase58 } from '../src/onchain/base58';
import { UsageBudget } from '../src/onchain/budget';
import { assertNetworkAllowed, isLoopbackUrl, loadOnchainConfig, networkEndpoints } from '../src/onchain/config';
import { openOnchainDb } from '../src/onchain/db';
import { DexScreenerDiscovery, applyWatchChange, discoverOnce, type DiscoverySource } from '../src/onchain/discovery';
import type { RpcTransaction } from '../src/onchain/extract';
import { BudgetExhaustedError, withApiKey } from '../src/onchain/helius';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, loadPinnedDecoder } from '../src/onchain/idl';
import { PoolResolver } from '../src/onchain/pools';
import { OnchainRecorder, type WsLike } from '../src/onchain/recorder';
import { WatchlistManager, type WatchCandidate } from '../src/onchain/watchlist';
import { ManualClock, realObs } from './helpers';
import { LocalWsServer } from './local-ws-server';
import { FakeRpc, FakeWs, ixLogs, synthAddress, synthEvent, synthSignature, synthTx } from './onchain-fixtures';

/**
 * ALL FIXTURES ARE SYNTHETIC (see onchain-fixtures.ts). Side effects: databases in an OS temp
 * directory; WebSocket/RPC are fakes or a local 127.0.0.1 test server; the test-wide network guard
 * (setup-network-guard.ts) blocks every non-loopback fetch/WebSocket. Child processes inherit
 * VITEST / ONCHAIN_FORBID_NETWORK, so the CLI refuses remote endpoints. Nothing under apps/api/data
 * is opened.
 */
const dir = mkdtempSync(join(tmpdir(), 'spb-onchain-life-'));
const opened: Database.Database[] = [];
afterAll(() => {
  for (const d of opened) if (d.open) d.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
let n = 0;
const tmpDb = (name = 'life') => join(dir, `${name}-${n++}.db`);
const openDb = (file = tmpDb()) => {
  const d = openOnchainDb(file, null, 1);
  opened.push(d);
  return d;
};
const count = (db: Database.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const decoder = loadPinnedDecoder();
const LIMITS = { dailyCredits: 100_000, monthlyCredits: 1_000_000, dailyBytes: 500_000_000 };
const MODEL = { creditsPerRpcCall: 1, wsCreditsPer100Kb: 2, wsCreditsPerConnection: 1 };
const MIN = 60_000;
const mint = (label: string) => synthAddress(`mint-${label}`);
const cand = (label: string, over: Partial<WatchCandidate> = {}): WatchCandidate => ({ mint: mint(label), dexId: 'pumpfun', pairAddress: synthAddress(`pair-${label}`), pairCreatedAt: 1, ...over });
const SOL = '11111111111111111111111111111111';

async function waitFor(cond: () => boolean, timeoutMs = 8_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

// ------------------------------------------------------------------ network isolation

describe('network isolation', () => {
  it('the test-wide guard blocks non-loopback fetch and WebSocket', async () => {
    await expect(fetch('https://mainnet.helius-rpc.com/?api-key=synthetic')).rejects.toThrow(/test network guard/);
    expect(() => new WebSocket('wss://mainnet.helius-rpc.com/?api-key=synthetic')).toThrow(/test network guard/);
    expect(process.env.ONCHAIN_FORBID_NETWORK).toBe('true');
  });

  const base = { DATABASE_URL: 'sqlite::memory:', RECORDER_DATABASE_URL: `sqlite:${join(dir, 'cfg.db')}`, HELIUS_API_KEY: 'synthetic-key' };

  it('requires --live for remote endpoints and refuses them in a test environment even with --live', () => {
    const remote = loadOnchainConfig(base); // default Helius + DexScreener URLs
    expect(networkEndpoints(remote).map((e) => e.name)).toEqual(['HELIUS_WS_URL', 'HELIUS_RPC_URL', 'DEXSCREENER_BASE_URL']);
    expect(() => assertNetworkAllowed(remote, { live: false, env: {} })).toThrow(/without --live/);
    expect(() => assertNetworkAllowed(remote, { live: true, env: { VITEST: 'true' } })).toThrow(/test environment/);
    expect(() => assertNetworkAllowed(remote, { live: true, env: { NODE_ENV: 'test' } })).toThrow(/test environment/);
    expect(() => assertNetworkAllowed(remote, { live: true, env: { ONCHAIN_FORBID_NETWORK: 'true' } })).toThrow(/test environment/);
    expect(() => assertNetworkAllowed(remote, { live: true, env: {} })).not.toThrow();
    // the error names hosts only, never the key
    try {
      assertNetworkAllowed(remote, { live: false, env: {} });
    } catch (e) {
      expect(String(e)).not.toContain('synthetic-key');
    }
  });

  it('allows loopback-only endpoints without --live (local test server)', () => {
    const local = loadOnchainConfig({ ...base, HELIUS_WS_URL: 'ws://127.0.0.1:9/', HELIUS_RPC_URL: 'http://localhost:9/', ONCHAIN_DISCOVERY: 'off' });
    expect(() => assertNetworkAllowed(local, { live: false, env: { VITEST: 'true' } })).not.toThrow();
    const withDiscovery = loadOnchainConfig({ ...base, HELIUS_WS_URL: 'ws://127.0.0.1:9/', HELIUS_RPC_URL: 'http://127.0.0.1:9/' });
    expect(() => assertNetworkAllowed(withDiscovery, { live: false, env: {} })).toThrow(/DEXSCREENER_BASE_URL/);
    expect(isLoopbackUrl('ws://[::1]:1/')).toBe(true);
    expect(isLoopbackUrl('wss://127.0.0.1.evil.example/')).toBe(false);
  });

  it('rejects the removed program-wide subscription option', () => {
    expect(() => loadOnchainConfig({ ...base, ONCHAIN_PROGRAM_SUBSCRIPTIONS: 'pump' })).toThrow(/no longer supported/);
  });
});

/** Runs the on-chain CLI as a child process (async, so a local server in this process keeps serving). */
function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/onchain/cli.ts', ...args], { cwd: join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe('CLI network gate (child process)', () => {
  const cliEnv = (over: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env, // includes VITEST and ONCHAIN_FORBID_NETWORK from the test runner
    DATABASE_URL: `sqlite:${join(dir, 'paper-placeholder.db')}`,
    RECORDER_DATABASE_URL: `sqlite:${join(dir, 'cli-rec.db')}`,
    HELIUS_API_KEY: 'synthetic-cli-key-000',
    HELIUS_WS_URL: 'wss://mainnet.helius-rpc.com/',
    HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com/',
    DEXSCREENER_BASE_URL: 'https://api.dexscreener.com',
    ONCHAIN_DISCOVERY: 'dexscreener',
    ONCHAIN_WATCHLIST: mint('cli'),
    ...over,
  });

  it('refuses a fake key with default remote URLs, with and without --live, before opening anything', async () => {
    for (const args of [['record', '--migrate'], ['record', '--live', '--migrate']]) {
      const r = await runCli(args, cliEnv({}));
      expect(r.code, r.out).toBe(6);
      expect(r.out).toMatch(/test environment/);
      expect(r.out).not.toContain('synthetic-cli-key-000');
    }
    expect(existsSync(join(dir, 'cli-rec.db'))).toBe(false);
  }, 120_000);

  it('outside a test environment, still refuses remote endpoints without --live', async () => {
    const env = cliEnv({});
    for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k === 'NODE_ENV' || k === 'ONCHAIN_FORBID_NETWORK') delete env[k];
    const r = await runCli(['record', '--migrate'], env); // never pass --live here
    expect(r.code, r.out).toBe(6);
    expect(r.out).toMatch(/without --live/);
    expect(existsSync(join(dir, 'cli-rec.db'))).toBe(false);
  }, 60_000);

  it('records end to end against a local WebSocket server (loopback, no --live)', async () => {
    const server = new LocalWsServer();
    const port = await server.start();
    let sub = 500;
    server.onMessage = (m, reply) => {
      if (m.method === 'logsSubscribe') reply({ jsonrpc: '2.0', id: m.id, result: sub++ });
    };
    const recFile = join(dir, 'cli-e2e.db');
    const r = await runCli(
      ['record', '--migrate', '--max-minutes', '0.05'],
      cliEnv({
        RECORDER_DATABASE_URL: `sqlite:${recFile}`,
        HELIUS_WS_URL: `ws://127.0.0.1:${port}/`,
        HELIUS_RPC_URL: `http://127.0.0.1:${port}/`,
        ONCHAIN_DISCOVERY: 'off',
      }),
    );
    await server.stop();
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('synthetic-cli-key-000');
    expect(server.received.some((t) => t.includes('logsSubscribe') && t.includes(mint('cli')))).toBe(true);
    const db = new Database(recFile, { readonly: true });
    expect(db.prepare('SELECT stop_reason FROM onchain_sessions').get()).toEqual({ stop_reason: 'max_minutes_0.05' });
    expect(db.prepare('SELECT status, source FROM onchain_watchlist').get()).toEqual({ status: 'active', source: 'static' });
    db.close();
  }, 120_000);
});

// ------------------------------------------------------------------ watchlist and discovery

function watchlist(over: Partial<ConstructorParameters<typeof WatchlistManager>[0]> = {}) {
  const db = over.db ?? openDb();
  const clock = new ManualClock();
  const w = new WatchlistManager({ db, clock: clock.now, maxActive: 3, idleEvictMs: 60 * MIN, minWatchMs: 15 * MIN, staticMints: [], ...over });
  return { db, clock, w };
}

describe('watchlist', () => {
  it('activates static mints, deduplicates candidates, ignores invalid ones and queues over capacity (newest first)', () => {
    const { w, db } = watchlist({ staticMints: [mint('s')] });
    expect(w.init()).toEqual([mint('s')]);
    const res = w.ingest([cand('a', { pairCreatedAt: 10 }), cand('a', { pairCreatedAt: 10 }), cand('b', { pairCreatedAt: 30 }), cand('c', { pairCreatedAt: 20 }), { ...cand('x'), mint: 'not-a-mint' }]);
    expect(res.added).toEqual([mint('b'), mint('c')]); // capacity 3 incl. the static mint
    expect(w.get(mint('a'))!.status).toBe('pending');
    expect(count(db, 'SELECT COUNT(*) AS n FROM onchain_watchlist')).toBe(4);
    expect(count(db, 'SELECT COUNT(*) AS n FROM onchain_watch_periods WHERE to_ts IS NULL')).toBe(3);
  });

  it('evicts idle discovered mints (never static ones) and promotes pending ones, recording watch periods', () => {
    const { w, clock, db } = watchlist({ staticMints: [mint('s')] });
    w.init();
    w.ingest([cand('a', { pairCreatedAt: 30 }), cand('b', { pairCreatedAt: 20 }), cand('c', { pairCreatedAt: 10 })]); // newest first
    expect(w.active()[0]).toBe(mint('s'));
    expect(w.active().slice(1).sort()).toEqual([mint('a'), mint('b')].sort());
    clock.advance(30 * MIN);
    w.noteEvent({ eventType: 'TradeEvent', mint: mint('a'), pool: null, at: clock.now() });
    clock.advance(31 * MIN); // b idle 61 min, a active 31 min ago
    const ch = w.rebalance();
    expect(ch.removed).toEqual([mint('b')]);
    expect(ch.added).toEqual([mint('c')]);
    expect(w.get(mint('b'))).toMatchObject({ status: 'evicted', evict_reason: 'idle' });
    expect(db.prepare('SELECT to_ts, end_reason FROM onchain_watch_periods WHERE mint = ?').get(mint('b'))).toEqual({ to_ts: clock.now(), end_reason: 'idle' });
    clock.advance(10 * 60 * MIN);
    expect(w.rebalance().removed).not.toContain(mint('s'));
    // rediscovery re-queues an evicted mint with a new watch period
    w.ingest([cand('b')]);
    expect(w.get(mint('b'))!.status).toBe('active');
    expect(count(db, 'SELECT COUNT(*) AS n FROM onchain_watch_periods WHERE mint = ?', mint('b'))).toBe(2);
  });

  it('under capacity pressure evicts only mints watched for at least minWatchMs, least active first', () => {
    const { w, clock } = watchlist();
    w.init();
    w.ingest([cand('a'), cand('b'), cand('c')]);
    clock.advance(5 * MIN);
    expect(w.ingest([cand('d')]).removed).toEqual([]); // nobody watched for 15 min yet
    expect(w.get(mint('d'))!.status).toBe('pending');
    clock.advance(11 * MIN);
    w.noteEvent({ eventType: 'TradeEvent', mint: mint('a'), pool: null, at: clock.now() });
    w.noteEvent({ eventType: 'TradeEvent', mint: mint('c'), pool: null, at: clock.now() });
    const ch = w.ingest([cand('d')]);
    expect(ch.removed).toEqual([mint('b')]);
    expect(ch.added).toEqual([mint('d')]);
    expect(w.get(mint('b'))!.evict_reason).toBe('capacity');
  });

  it('sheds discovered mints when static mints exceed the free capacity', () => {
    const db = openDb();
    const first = watchlist({ db });
    first.w.init();
    first.w.ingest([cand('a'), cand('b'), cand('c')]);
    const second = new WatchlistManager({ db, clock: first.clock.now, maxActive: 3, idleEvictMs: 60 * MIN, minWatchMs: 15 * MIN, staticMints: [mint('s1'), mint('s2')] });
    const active = second.init();
    expect(active.slice(0, 2)).toEqual([mint('s1'), mint('s2')]);
    expect(active).toHaveLength(3);
  });

  it('tracks lifecycle: DexScreener reports are provisional, on-chain evidence wins and advances', () => {
    const { w } = watchlist();
    w.init();
    const res = w.ingest([cand('m', { dexId: 'pumpswap', pairAddress: synthAddress('reported-pool') })]);
    expect(res.poolHints).toEqual([{ mint: mint('m'), pool: synthAddress('reported-pool') }]);
    expect(w.get(mint('m'))).toMatchObject({ lifecycle: 'migrated', lifecycle_source: 'dexscreener_reported', pool: null });
    // on-chain evidence replaces the report even when it says "earlier" (the report may be wrong)
    w.noteEvent({ eventType: 'TradeEvent', mint: mint('m'), pool: null, at: 1 });
    expect(w.get(mint('m'))).toMatchObject({ lifecycle: 'bonding_curve', lifecycle_source: 'onchain_event' });
    w.noteEvent({ eventType: 'CompleteEvent', mint: mint('m'), pool: null, at: 2 });
    expect(w.get(mint('m'))!.lifecycle).toBe('complete');
    w.noteEvent({ eventType: 'TradeEvent', mint: mint('m'), pool: null, at: 3 }); // never goes backwards
    expect(w.get(mint('m'))!.lifecycle).toBe('complete');
    w.noteEvent({ eventType: 'CompletePumpAmmMigrationEvent', mint: mint('m'), pool: synthAddress('real-pool'), at: 4 });
    expect(w.get(mint('m'))).toMatchObject({ lifecycle: 'migrated', lifecycle_source: 'onchain_event', pool: synthAddress('real-pool') });
    // a later DexScreener report cannot override on-chain lifecycle
    w.ingest([cand('m', { dexId: 'pumpfun' })]);
    expect(w.get(mint('m'))).toMatchObject({ lifecycle: 'migrated', lifecycle_source: 'onchain_event' });
  });

  it('DexScreenerDiscovery maps validated observations and skips invalid ones', async () => {
    const now = Date.UTC(2026, 5, 1);
    const provider = {
      poll: async () => ({
        observations: [realObs(now, { mint: mint('d1'), dexId: 'pumpfun', pairAddress: synthAddress('p1') }), { mint: 'garbage' }],
        skipped: [],
        warnings: [],
      }),
    };
    const c = await new DexScreenerDiscovery(provider).discover();
    expect(c).toEqual([{ mint: mint('d1'), dexId: 'pumpfun', pairAddress: synthAddress('p1'), pairCreatedAt: now - 60 * MIN }]);
  });

  it('discoverOnce feeds new curves and migrated pools into subscriptions and pool hints; failures change nothing but idle eviction', async () => {
    const { w } = watchlist();
    w.init();
    const calls: string[] = [];
    const target = {
      addSubscription: (a: string) => calls.push(`+${a}`),
      removeSubscription: (a: string) => calls.push(`-${a}`),
      pools: { hint: (p: string, by: string) => calls.push(`hint:${p}:${by}`) },
    };
    const src: DiscoverySource = { discover: async () => [cand('new-curve'), cand('migrated', { dexId: 'pumpswap', pairAddress: synthAddress('mp') })] };
    const r = await discoverOnce(src, w, target);
    expect(r).toMatchObject({ hinted: 1, error: null });
    expect(calls).toEqual([`hint:${synthAddress('mp')}:dexscreener`, `+${mint('new-curve')}`, `+${mint('migrated')}`]);
    const failing: DiscoverySource = {
      discover: async () => {
        throw new Error('synthetic outage');
      },
    };
    const f = await discoverOnce(failing, w, target);
    expect(f).toMatchObject({ added: [], removed: [], error: 'synthetic outage' });
    applyWatchChange(target, { added: [], removed: [] });
  });
});

// ------------------------------------------------------------------ pool resolution

const POOL_DISC = createHash('sha256').update('account:Pool').digest().subarray(0, 8);
/** SYNTHETIC Pool account bytes: discriminator, pool_bump, index, creator, base_mint, quote_mint, padding. */
function poolAccount(base: string, quote: string, disc: Uint8Array = POOL_DISC): [string, string] {
  const key = (a: string) => Buffer.from(decodeBase58(a));
  const parts = [Buffer.from(disc), Buffer.from([254]), Buffer.from([0, 0]), key(synthAddress('creator')), key(base), key(quote), Buffer.alloc(300)];
  return [Buffer.concat(parts).toString('base64'), 'base64'];
}

function resolver(rpc: FakeRpc | null, over: { maxAttempts?: number; retryAfterMs?: number } = {}) {
  const db = openDb();
  const clock = new ManualClock();
  const resolvedRows: string[] = [];
  const r = new PoolResolver({ db, amm: decoder.amm, rpc, clock: clock.now, onResolved: (row) => resolvedRows.push(row.pool), ...over });
  return { db, clock, r, resolvedRows };
}

describe('pool resolution (pools that migrated before recording)', () => {
  const POOL = synthAddress('pool-x');
  const BASE = mint('base');
  const QUOTE = SOL;

  it('resolves from a verified Pool account (owner + discriminator checked)', async () => {
    const rpc = new FakeRpc();
    rpc.accounts.set(POOL, { owner: PUMP_AMM_PROGRAM_ID, data: poolAccount(BASE, QUOTE) });
    const { r, resolvedRows } = resolver(rpc);
    r.request(POOL);
    await r.idle();
    expect(r.get(POOL)).toMatchObject({ status: 'resolved', base_mint: BASE, quote_mint: QUOTE, method: 'pool_account' });
    expect(resolvedRows).toEqual([POOL]);
  });

  it('never guesses: wrong owner, wrong discriminator and missing accounts are unresolvable', async () => {
    const rpc = new FakeRpc();
    const p1 = synthAddress('p-owner');
    const p2 = synthAddress('p-disc');
    const p3 = synthAddress('p-missing');
    rpc.accounts.set(p1, { owner: PUMP_PROGRAM_ID, data: poolAccount(BASE, QUOTE) });
    rpc.accounts.set(p2, { owner: PUMP_AMM_PROGRAM_ID, data: poolAccount(BASE, QUOTE, Buffer.alloc(8, 1)) });
    const { r } = resolver(rpc);
    for (const p of [p1, p2, p3]) r.request(p);
    await r.idle();
    expect(r.get(p1)).toMatchObject({ status: 'unresolvable', base_mint: null, detail: expect.stringMatching(/owner/) });
    expect(r.get(p2)).toMatchObject({ status: 'unresolvable', base_mint: null, detail: expect.stringMatching(/discriminator/) });
    expect(r.get(p3)).toMatchObject({ status: 'unresolvable', base_mint: null, detail: expect.stringMatching(/not found/) });
    r.request(p1); // unresolvable pools are not retried
    await r.idle();
    expect(rpc.accountCalls.filter((a) => a === p1)).toHaveLength(1);
  });

  it('retries transient failures with spacing and a cap; budget refusals do not count as attempts', async () => {
    const rpc = new FakeRpc();
    rpc.accountError = new Error('synthetic 503');
    const { r, clock } = resolver(rpc, { maxAttempts: 2, retryAfterMs: 10 * MIN });
    r.request(POOL);
    await r.idle();
    expect(r.get(POOL)).toMatchObject({ status: 'unresolved', attempts: 1 });
    r.request(POOL); // too soon
    await r.idle();
    expect(rpc.accountCalls).toHaveLength(1);
    clock.advance(11 * MIN);
    r.request(POOL);
    await r.idle();
    expect(r.get(POOL)!.attempts).toBe(2);
    clock.advance(11 * MIN);
    r.request(POOL); // cap reached
    await r.idle();
    expect(rpc.accountCalls).toHaveLength(2);

    const rpc2 = new FakeRpc();
    rpc2.accountError = new BudgetExhaustedError('synthetic budget');
    const b = resolver(rpc2);
    b.r.request(POOL);
    await b.r.idle();
    expect(b.r.get(POOL)).toMatchObject({ status: 'unresolved', attempts: 0, detail: expect.stringMatching(/budget/) });
  });

  it('resolves from swap instruction accounts of a fetched transaction', () => {
    const { r } = resolver(null);
    const buyDisc = createHash('sha256').update('global:buy').digest().subarray(0, 8);
    const tx: RpcTransaction = {
      slot: 1,
      transaction: {
        signatures: [synthSignature('ix')],
        message: {
          accountKeys: [synthAddress('payer'), PUMP_AMM_PROGRAM_ID, POOL, BASE, QUOTE, synthAddress('global-config')],
          instructions: [{ programIdIndex: 1, accounts: [2, 0, 5, 3, 4], data: encodeBase58(Buffer.concat([buyDisc, Buffer.alloc(16)])) }],
        },
      },
      meta: { err: null, logMessages: [], innerInstructions: [] },
    };
    expect(r.recordFromTransaction(synthSignature('ix'), tx)).toBe(1);
    expect(r.get(POOL)).toMatchObject({ status: 'resolved', base_mint: BASE, quote_mint: QUOTE, method: 'instruction_accounts' });
  });

  it('marks disagreeing evidence as conflict and stops using the pool', () => {
    const { r } = resolver(null);
    r.recordEvidence(POOL, BASE, QUOTE, 'onchain_event', 'synthetic CreatePoolEvent');
    r.recordEvidence(POOL, BASE, QUOTE, 'instruction_accounts', 'agrees');
    expect(r.get(POOL)).toMatchObject({ status: 'resolved', method: 'onchain_event' });
    r.recordEvidence(POOL, mint('other'), QUOTE, 'pool_account', 'disagrees');
    expect(r.get(POOL)).toMatchObject({ status: 'conflict', base_mint: null });
    expect(r.resolved(POOL)).toBeNull();
    r.recordEvidence(POOL, BASE, QUOTE, 'onchain_event', 'later'); // conflict is sticky
    expect(r.get(POOL)!.status).toBe('conflict');
  });

  it('a DexScreener hint triggers verification; the pool attaches to the on-chain base mint, not the hinted one', async () => {
    const rpc = new FakeRpc();
    const db = openDb();
    const clock = new ManualClock();
    const w = new WatchlistManager({ db, clock: clock.now, maxActive: 5, idleEvictMs: 60 * MIN, minWatchMs: 15 * MIN, staticMints: [] });
    w.init();
    const res = w.ingest([cand('hinted', { dexId: 'pumpswap', pairAddress: POOL })]);
    rpc.accounts.set(POOL, { owner: PUMP_AMM_PROGRAM_ID, data: poolAccount(mint('actual'), QUOTE) }); // DexScreener was wrong
    const r = new PoolResolver({ db, amm: decoder.amm, rpc, clock: clock.now, onResolved: (row) => w.notePoolResolved(row.pool, row.base_mint!, row.method!) });
    for (const h of res.poolHints) r.hint(h.pool, 'dexscreener');
    await r.idle();
    expect(r.get(POOL)).toMatchObject({ status: 'resolved', base_mint: mint('actual'), reported_by: 'dexscreener' });
    expect(w.get(mint('hinted'))!.pool).toBeNull();
  });
});

// ------------------------------------------------------------------ recorder: subscription lifecycle, keepalive, pools

function setup(over: { subscriptions?: string[]; limits?: typeof LIMITS; keepalive?: { intervalMs: number; staleAfterMs: number } } = {}) {
  const db = openDb();
  const clock = new ManualClock();
  const budget = new UsageBudget(db, over.limits ?? LIMITS, MODEL, clock.now);
  const sockets: FakeWs[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const logs: string[] = [];
  const rpc = new FakeRpc();
  const subscribedHook: string[] = [];
  const events: string[] = [];
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
    wsUrl: withApiKey('wss://ws.example.test/', 'synthetic-life-key'),
    apiKey: 'synthetic-life-key',
    subscriptions: over.subscriptions ?? [mint('a')],
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
    backfillMaxSignatures: 100,
    backfillOnStart: true,
    storeRaw: 'all',
    maxTxVersion: 1,
    keepalive: over.keepalive ?? { intervalMs: 60_000, staleAfterMs: 150_000 },
    hooks: { onSubscribed: (a) => subscribedHook.push(a), onEvent: (e) => events.push(`${e.eventType}:${e.mint}`) },
    runConfig: { synthetic: true },
  });
  const run = (ms: number) => {
    const t = timers.find((x) => !x.cancelled && x.ms === ms);
    if (!t) throw new Error(`no pending timer of ${ms} ms`);
    t.cancelled = true;
    t.fn();
  };
  const ws = () => sockets[sockets.length - 1]!;
  return { db, clock, budget, sockets, timers, logs, rpc, rec, run, ws, subscribedHook, events };
}
const sent = (ws: FakeWs, method: string) => ws.sent.filter((s) => s.method === method);

describe('recorder subscription lifecycle', () => {
  it('adds a discovered mint on a live connection and becomes live again once confirmed', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    expect(s.rec.status).toBe('live');
    s.rec.addSubscription(mint('b'));
    expect(s.rec.status).toBe('connecting');
    const req = sent(s.ws(), 'logsSubscribe').at(-1)!;
    expect(req.params[0]).toEqual({ mentions: [mint('b')] });
    s.ws().msg({ jsonrpc: '2.0', id: req.id, result: 777 });
    expect(s.rec.status).toBe('live');
    expect(s.subscribedHook).toEqual([mint('a'), mint('b')]);
  });

  it('removes a mint: unsubscribes by subscription id, drops its cursor and ends its open gap with a note', async () => {
    const s = setup({ subscriptions: [mint('a'), mint('b')] });
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.ws().notify(subs.get(mint('b'))!, synthSignature('b0'), 10, []);
    expect(count(s.db, 'SELECT COUNT(*) AS n FROM onchain_cursors WHERE subscription = ?', mint('b'))).toBe(1);
    s.rec.removeSubscription(mint('b'));
    expect(sent(s.ws(), 'logsUnsubscribe').at(-1)!.params).toEqual([subs.get(mint('b'))]);
    expect(count(s.db, 'SELECT COUNT(*) AS n FROM onchain_cursors WHERE subscription = ?', mint('b'))).toBe(0);
    expect(s.rec.subscriptions()).toEqual([mint('a')]);
    // a notification still in flight for the removed subscription is ignored
    s.ws().notify(subs.get(mint('b'))!, synthSignature('late'), 11, ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent', { mint: mint('b') }).payload]));
    expect(count(s.db, 'SELECT COUNT(*) AS n FROM chain_events')).toBe(0);
    // after a disconnect only the watched mint gets a gap
    s.ws().serverDrop();
    expect(s.db.prepare('SELECT subscription FROM onchain_gaps').all()).toEqual([{ subscription: mint('a') }]);
  });

  it('undoes a subscription removed while its request was in flight', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    s.rec.addSubscription(mint('c'));
    const req = sent(s.ws(), 'logsSubscribe').at(-1)!;
    s.rec.removeSubscription(mint('c'));
    s.ws().msg({ jsonrpc: '2.0', id: req.id, result: 900 });
    expect(sent(s.ws(), 'logsUnsubscribe').at(-1)!.params).toEqual([900]);
    expect(s.rec.status).toBe('live');
  });

  it('does not backfill a gap of a mint that was unwatched before reconnecting', async () => {
    const s = setup({ subscriptions: [mint('a'), mint('b')] });
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.ws().notify(subs.get(mint('b'))!, synthSignature('b-before'), 10, []);
    s.ws().serverDrop();
    s.rec.removeSubscription(mint('b'));
    s.run(1000);
    s.ws().open();
    s.ws().confirmAll(50);
    await s.rec.idle();
    expect(s.rpc.sigCalls.map((c) => c.address)).not.toContain(mint('b'));
    expect(s.db.prepare('SELECT status, note FROM onchain_gaps WHERE subscription = ?').get(mint('b'))).toMatchObject({ status: 'open', note: expect.stringMatching(/unwatched/) });
    // the watched mint without a cursor is explicitly unverifiable
    expect((s.db.prepare('SELECT status FROM onchain_gaps WHERE subscription = ?').get(mint('a')) as { status: string }).status).toBe('unverifiable');
  });

  it('applies subscriptions added while paused for budget only after resuming', () => {
    const s = setup({ limits: { ...LIMITS, dailyBytes: 1_500 } });
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.ws().notify(subs.get(mint('a'))!, synthSignature('big'), 1, ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent').payload, synthEvent('pump', 'TradeEvent').payload]));
    expect(s.rec.status).toBe('paused_budget');
    s.rec.addSubscription(mint('d'));
    expect(s.sockets).toHaveLength(1);
    const resume = s.timers.find((t) => !t.cancelled && t.ms > 60_000)!;
    s.clock.advance(resume.ms);
    resume.cancelled = true;
    resume.fn();
    expect(s.sockets).toHaveLength(2);
    s.ws().open();
    expect(sent(s.ws(), 'logsSubscribe').map((r) => (r.params[0] as { mentions: string[] }).mentions[0])).toEqual([mint('a'), mint('d')]);
  });
});

describe('recorder keepalive', () => {
  it('sends a JSON-RPC ping each interval and keeps a quiet but answering connection', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    for (let i = 0; i < 4; i++) {
      s.clock.advance(60_000);
      s.run(60_000);
      const ping = sent(s.ws(), 'ping').at(-1)!;
      s.ws().msg({ jsonrpc: '2.0', id: ping.id, error: { code: -32601, message: 'Method not found' } });
    }
    expect(sent(s.ws(), 'ping')).toHaveLength(4);
    expect(s.rec.stats.keepalivesSent).toBe(4);
    expect(s.sockets).toHaveLength(1);
    expect(s.logs.filter((l) => l.includes('keepalive')).length).toBe(1); // unsupported-method note logged once
  });

  it('treats a silent connection as stale: gap opened, reconnect scheduled, old socket gets no more pings', () => {
    const s = setup();
    s.rec.start();
    s.ws().open();
    s.ws().confirmAll();
    s.clock.advance(60_000);
    s.run(60_000);
    s.clock.advance(60_000);
    s.run(60_000);
    s.clock.advance(60_000);
    s.run(60_000); // 180 s without any inbound message > 150 s
    expect(s.rec.status).toBe('reconnecting');
    expect(s.rec.stats.staleReconnects).toBe(1);
    expect(s.sockets[0]!.closed).toMatchObject({ code: 4002 });
    expect(count(s.db, "SELECT COUNT(*) AS n FROM onchain_gaps WHERE kind = 'disconnect'")).toBe(1);
    expect(s.timers.filter((t) => !t.cancelled && t.ms === 60_000)).toHaveLength(0);
    s.run(1000);
    expect(s.sockets).toHaveLength(2);
  });
});

describe('recorder pool resolution', () => {
  it('stores PumpSwap trades unresolved, looks the pool up, and exposes the mint through chain_events_resolved', async () => {
    const s = setup();
    const pool = synthAddress('live-pool');
    s.rpc.accounts.set(pool, { owner: PUMP_AMM_PROGRAM_ID, data: poolAccount(mint('a'), SOL) });
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.ws().notify(subs.get(mint('a'))!, synthSignature('amm-1'), 5, ixLogs(PUMP_AMM_PROGRAM_ID, [synthEvent('pump_amm', 'BuyEvent', { pool }).payload]));
    await s.rec.idle();
    expect(s.db.prepare('SELECT mint, mint_source FROM chain_events').get()).toEqual({ mint: null, mint_source: null }); // row never rewritten
    expect(s.db.prepare('SELECT resolved_mint, resolved_mint_source, resolved_quote_mint FROM chain_events_resolved').get()).toEqual({
      resolved_mint: mint('a'),
      resolved_mint_source: 'pool:pool_account',
      resolved_quote_mint: SOL,
    });
    s.ws().notify(subs.get(mint('a'))!, synthSignature('amm-2'), 6, ixLogs(PUMP_AMM_PROGRAM_ID, [synthEvent('pump_amm', 'SellEvent', { pool }).payload]));
    expect(s.db.prepare('SELECT mint, mint_source, quote_asset FROM chain_events WHERE signature = ?').get(synthSignature('amm-2'))).toEqual({
      mint: mint('a'),
      mint_source: 'pool:pool_account',
      quote_asset: 'SOL',
    });
    expect(s.rpc.accountCalls).toEqual([pool]); // looked up once
    expect(s.events).toContain(`SellEvent:${mint('a')}`);
  });

  it('leaves the mint unresolved when the pool cannot be verified', async () => {
    const s = setup();
    const pool = synthAddress('fake-pool');
    s.rpc.accounts.set(pool, { owner: synthAddress('some-other-program'), data: poolAccount(mint('a'), SOL) });
    s.rec.start();
    s.ws().open();
    const subs = s.ws().confirmAll();
    s.ws().notify(subs.get(mint('a'))!, synthSignature('amm-x'), 5, ixLogs(PUMP_AMM_PROGRAM_ID, [synthEvent('pump_amm', 'BuyEvent', { pool }).payload]));
    await s.rec.idle();
    expect(s.db.prepare('SELECT resolved_mint FROM chain_events_resolved').get()).toEqual({ resolved_mint: null });
    expect(s.db.prepare('SELECT status FROM onchain_pools WHERE pool = ?').get(pool)).toEqual({ status: 'unresolvable' });
  });

  it('resolves from instruction accounts during backfill before storing the events', async () => {
    const s = setup();
    const pool = synthAddress('bf-pool');
    s.rec.start();
    s.ws().open();
    let subs = s.ws().confirmAll();
    s.ws().notify(subs.get(mint('a'))!, synthSignature('a0'), 1, []);
    s.ws().serverDrop();
    s.run(1000);
    const sig = synthSignature('bf-1');
    const tx = synthTx(2, PUMP_AMM_PROGRAM_ID, [synthEvent('pump_amm', 'SellEvent', { pool }).payload]);
    const sellDisc = createHash('sha256').update('global:sell').digest().subarray(0, 8);
    tx.transaction.message.accountKeys.push(pool, mint('a'), SOL, synthAddress('gc'));
    tx.transaction.message.instructions = [{ programIdIndex: 1, accounts: [3, 0, 6, 4, 5], data: encodeBase58(Buffer.concat([sellDisc, Buffer.alloc(16)])) }];
    s.rpc.sigPages = [[{ signature: sig, slot: 2, err: null }]];
    s.rpc.txs.set(sig, tx);
    s.ws().open();
    subs = s.ws().confirmAll(20);
    await s.rec.idle();
    expect(s.db.prepare('SELECT mint, mint_source FROM chain_events WHERE signature = ?').get(sig)).toEqual({ mint: mint('a'), mint_source: 'pool:instruction_accounts' });
    expect(s.rpc.accountCalls).toEqual([]);
  });
});

// ------------------------------------------------------------------ real Node WebSocket against a local server

describe('recorder with a real WebSocket and a local server', () => {
  it('subscribes, records, keeps alive, recovers from drops and from a stale (silent) server', async () => {
    const server = new LocalWsServer();
    const port = await server.start();
    let mode: 'answer' | 'silent' = 'answer';
    let nextSub = 1;
    const subOf = new Map<string, number>();
    let pings = 0;
    server.onMessage = (m, reply) => {
      if (m.method === 'logsSubscribe') {
        const id = nextSub++;
        subOf.set((m.params![0] as { mentions: string[] }).mentions[0]!, id);
        reply({ jsonrpc: '2.0', id: m.id, result: id });
      } else if (m.method === 'ping') {
        pings++;
        if (mode === 'answer') reply({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      }
    };
    const db = openDb();
    const budget = new UsageBudget(db, LIMITS, MODEL, Date.now);
    const rpc = new FakeRpc();
    const rec = new OnchainRecorder({
      db,
      decoder,
      budget,
      rpc,
      wsFactory: (url) => new WebSocket(url) as unknown as WsLike, // the guarded global: loopback only
      wsUrl: withApiKey(`ws://127.0.0.1:${port}/`, 'synthetic-local-key'),
      apiKey: 'synthetic-local-key',
      subscriptions: [mint('a'), mint('b')],
      clock: Date.now,
      backfillMaxSignatures: 50,
      backfillOnStart: true,
      storeRaw: 'all',
      maxTxVersion: 1,
      backoff: { baseMs: 50, maxMs: 200, stableMs: 60_000 },
      connectTimeoutMs: 2_000,
      keepalive: { intervalMs: 150, staleAfterMs: 700 },
      runConfig: { synthetic: true },
    });
    try {
      rec.start();
      await waitFor(() => rec.status === 'live', 8_000, 'live');
      server.broadcast({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: { subscription: subOf.get(mint('a')), result: { context: { slot: 42 }, value: { signature: synthSignature('local-1'), err: null, logs: ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent', { mint: mint('a') }).payload]) } } },
      });
      await waitFor(() => count(db, 'SELECT COUNT(*) AS n FROM chain_events') === 1, 8_000, 'event stored');
      await waitFor(() => pings >= 3, 8_000, 'keepalive pings');
      expect(server.connections).toBe(1);

      server.dropAll(); // network failure
      await waitFor(() => server.connections === 2 && rec.status === 'live', 8_000, 'reconnect');
      await rec.idle();
      const gaps = db.prepare('SELECT subscription, status FROM onchain_gaps ORDER BY subscription = ? DESC').all(mint('a')) as { subscription: string; status: string }[];
      expect(gaps).toEqual([
        { subscription: mint('a'), status: 'backfilled_verified' }, // had a cursor; empty synthetic listing reached it
        { subscription: mint('b'), status: 'unverifiable' }, // never saw a signature: explicitly unverifiable
      ]);

      mode = 'silent'; // server stops answering anything: stale watchdog must recover
      await waitFor(() => server.connections === 3, 8_000, 'stale reconnect');
      expect(rec.stats.staleReconnects).toBeGreaterThanOrEqual(1);
      mode = 'answer';
      await waitFor(() => rec.status === 'live', 8_000, 'live again');
    } finally {
      await rec.stop('test');
      await server.stop();
    }
    expect(count(db, "SELECT COUNT(*) AS n FROM onchain_errors WHERE detail LIKE '%stale%'")).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(db.prepare('SELECT detail FROM onchain_errors').all())).not.toContain('synthetic-local-key');
  }, 30_000);

  it('reconnects with backoff when the server rejects a subscription, then runs with all subscriptions', async () => {
    const server = new LocalWsServer();
    const port = await server.start();
    let rejectNext = true;
    let sub = 1;
    server.onMessage = (m, reply) => {
      if (m.method !== 'logsSubscribe') return;
      if (rejectNext && (m.params![0] as { mentions: string[] }).mentions[0] === mint('b')) {
        rejectNext = false;
        reply({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'synthetic rejection' } });
        return;
      }
      reply({ jsonrpc: '2.0', id: m.id, result: sub++ });
    };
    const db = openDb();
    const rec = new OnchainRecorder({
      db,
      decoder,
      budget: new UsageBudget(db, LIMITS, MODEL, Date.now),
      rpc: new FakeRpc(),
      wsFactory: (url) => new WebSocket(url) as unknown as WsLike,
      wsUrl: `ws://127.0.0.1:${port}/`,
      apiKey: 'synthetic-local-key',
      subscriptions: [mint('a'), mint('b')],
      clock: Date.now,
      backfillMaxSignatures: 10,
      backfillOnStart: true,
      storeRaw: 'all',
      maxTxVersion: 1,
      backoff: { baseMs: 50, maxMs: 200, stableMs: 60_000 },
      keepalive: { intervalMs: 10_000, staleAfterMs: 30_000 },
      runConfig: { synthetic: true },
    });
    try {
      rec.start();
      await waitFor(() => server.connections === 2 && rec.status === 'live', 8_000, 'reconnect after rejection');
      expect(count(db, "SELECT COUNT(*) AS n FROM onchain_errors WHERE detail LIKE '%logsSubscribe failed%'")).toBe(1);
    } finally {
      await rec.stop('test');
      await server.stop();
    }
  }, 20_000);
});
