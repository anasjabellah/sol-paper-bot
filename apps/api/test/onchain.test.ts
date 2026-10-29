import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { decodeBase58, encodeBase58, isBase58Address } from '../src/onchain/base58';
import { BorshDecoder, BorshReader } from '../src/onchain/borsh';
import { UsageBudget, msUntilNextUtcDay } from '../src/onchain/budget';
import { describeConfig, loadOnchainConfig } from '../src/onchain/config';
import { ONCHAIN_TABLES, migrateToV2, openOnchainDb, readSchemaVersion } from '../src/onchain/db';
import { mergeCandidates, scanInnerInstructions, scanLogs } from '../src/onchain/extract';
import { ALLOWED_RPC_METHODS, BudgetExhaustedError, HeliusRpc, redact, withApiKey } from '../src/onchain/helius';
import { DECODER_VERSION, EVENT_IX_TAG, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, TARGET_EVENTS, loadPinnedDecoder } from '../src/onchain/idl';
import { normalizeEvent } from '../src/onchain/normalize';
import { OnchainRecorder } from '../src/onchain/recorder';
import { buildOnchainReport, formatOnchainReport } from '../src/onchain/report';
import { RecorderGuardError, openRecorderDb } from '../src/recorder/db';
import { ManualClock } from './helpers';
import { FakeRpc, FakeWs, SYNTH_TS, b64, ixLogs, synthAddress, synthEvent, synthSignature, synthTx } from './onchain-fixtures';

/**
 * ALL FIXTURES IN THIS FILE ARE SYNTHETIC. Event payloads are produced by a test-only Borsh encoder
 * driven by the pinned IDLs; addresses and signatures are sha256-derived placeholders; logs and
 * transactions are hand-built in the documented RPC shapes. None of it is captured mainnet data.
 *
 * Side effects: every database lives in an OS temp directory created here; WebSocket and RPC are
 * fakes; no network, no ports, nothing under apps/api/data is opened.
 */
const dir = mkdtempSync(join(tmpdir(), 'spb-onchain-'));
const opened: Database.Database[] = [];
afterAll(() => {
  for (const d of opened) if (d.open) d.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const openDb = (file: string) => {
  const d = openOnchainDb(file, null, 1);
  opened.push(d);
  return d;
};
let n = 0;
const tmpDb = (name = 'rec') => join(dir, `${name}-${n++}.db`);

const decoder = loadPinnedDecoder();
const PROGRAMS = new Set([PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]);

// ------------------------------------------------------------------ codec and IDL

describe('base58', () => {
  it('round-trips addresses, keeps leading zeros and rejects invalid characters', () => {
    expect(decodeBase58('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
    expect(encodeBase58(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    for (const a of [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]) {
      expect(decodeBase58(a)).toHaveLength(32);
      expect(encodeBase58(decodeBase58(a))).toBe(a);
    }
    expect(() => decodeBase58('0OIl')).toThrow(/Invalid base58/);
    expect(isBase58Address(PUMP_PROGRAM_ID)).toBe(true);
    expect(isBase58Address('not-an-address')).toBe(false);
  });
});

describe('pinned IDLs', () => {
  it('load with verified hashes, and every target discriminator is sha256("event:Name")[0..8]', () => {
    const specs = decoder.eventSpecs().filter((s) => s.targeted);
    expect(specs.map((s) => s.name).sort()).toEqual(Object.keys(TARGET_EVENTS).sort());
    const expected: Record<string, string> = {
      CreateEvent: '1b72a94ddeeb6376',
      TradeEvent: 'bddb7fd34ee661ee',
      CompleteEvent: '5f72619cd42e9808',
      CompletePumpAmmMigrationEvent: 'bde95db95c94ea94',
      BuyEvent: '67f4521f2cf57777',
      SellEvent: '3e2f370aa503dc2a',
      CreatePoolEvent: 'b1310cd2a076a774',
    };
    for (const s of specs) {
      expect(s.discriminatorHex).toBe(expected[s.name]);
      expect(s.programId).toBe(TARGET_EVENTS[s.name]!.program === 'pump' ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID);
    }
    expect(DECODER_VERSION).toMatch(/pump-sdk@4\.3\.1/);
  });

  it('pins the layouts that include quote_transfer_fee as the last trade-event field', () => {
    for (const [program, name] of [['pump', 'TradeEvent'], ['pump_amm', 'BuyEvent'], ['pump_amm', 'SellEvent']] as const) {
      const { fieldDefs } = synthEvent(program, name);
      expect(fieldDefs[fieldDefs.length - 1]).toEqual({ name: 'quote_transfer_fee', type: 'u64' });
    }
  });

  it('documents the Anchor emit_cpi tag byte order', () => {
    // Anchor's EVENT_IX_TAG is the u64 0x1d9acb512ea545e4 written little-endian.
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(0x1d9acb512ea545e4n);
    expect(Buffer.from(EVENT_IX_TAG)).toEqual(le);
  });
});

describe('borsh decoder', () => {
  it('decodes every synthetic target event exactly, with u64/i64/i128 as exact decimal strings', () => {
    for (const [name, t] of Object.entries(TARGET_EVENTS)) {
      const { fields, payload } = synthEvent(t.program, name);
      const d = decoder.decode(t.program === 'pump' ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID, payload);
      expect(d.status, name).toBe('ok');
      expect(d.fields, name).toEqual(fields);
      expect(d.trailingBytes).toBe(0);
    }
  });

  it('keeps extreme integers exact (beyond Number.MAX_SAFE_INTEGER)', () => {
    const max64 = '18446744073709551615';
    const { payload } = synthEvent('pump', 'TradeEvent', { sol_amount: max64, token_amount: '9007199254740993', quote_amount: max64 });
    const d = decoder.decode(PUMP_PROGRAM_ID, payload);
    expect(d.fields.sol_amount).toBe(max64);
    expect(d.fields.token_amount).toBe('9007199254740993'); // 2^53 + 1: not representable as a double
    const amm = synthEvent('pump_amm', 'BuyEvent', { virtual_quote_reserves: '-170141183460469231731687303715884105728' });
    expect(decoder.decode(PUMP_AMM_PROGRAM_ID, amm.payload).fields.virtual_quote_reserves).toBe('-170141183460469231731687303715884105728');
  });

  it('flags trailing bytes (ok_trailing) instead of ignoring them', () => {
    const { payload } = synthEvent('pump', 'TradeEvent');
    const d = decoder.decode(PUMP_PROGRAM_ID, Uint8Array.from([...payload, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(d.status).toBe('ok_trailing');
    expect(d.trailingBytes).toBe(8);
  });

  it('treats a payload ending at a field boundary after the core as partial, before the core as error', () => {
    const { payload, fieldDefs } = synthEvent('pump', 'CompleteEvent');
    const withoutQuoteMint = payload.subarray(0, payload.length - 32); // drop the last pubkey
    const p = decoder.decode(PUMP_PROGRAM_ID, withoutQuoteMint);
    expect(p.status).toBe('partial');
    expect(p.missingFields).toEqual([fieldDefs[fieldDefs.length - 1]!.name]);
    const tooShort = payload.subarray(0, 8 + 32 + 32); // user, mint only (core is 4 fields)
    const e = decoder.decode(PUMP_PROGRAM_ID, tooShort);
    expect(e.status).toBe('error');
    expect(e.error).toMatch(/core fields/);
  });

  it('fails visibly when a payload ends inside a field or has an invalid value', () => {
    const { payload } = synthEvent('pump', 'TradeEvent');
    const mid = decoder.decode(PUMP_PROGRAM_ID, payload.subarray(0, 8 + 32 + 3));
    expect(mid.status).toBe('error');
    expect(mid.error).toMatch(/sol_amount/);
    const bad = Uint8Array.from(payload);
    bad[8 + 32 + 8 + 8] = 7; // is_buy must be 0 or 1
    const b = decoder.decode(PUMP_PROGRAM_ID, bad);
    expect(b.status).toBe('error');
    expect(b.error).toMatch(/Invalid bool/);
  });

  it('reports unknown discriminators and unknown programs without throwing', () => {
    const u = decoder.decode(PUMP_PROGRAM_ID, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(u.status).toBe('unknown_discriminator');
    const other = decoder.decode(synthAddress('other-program'), synthEvent('pump', 'TradeEvent').payload);
    expect(other.status).toBe('error');
  });

  it('bounds corrupt vec lengths', () => {
    const dec = new BorshDecoder([]);
    const r = new BorshReader(Uint8Array.from([0xff, 0xff, 0xff, 0x7f]));
    expect(() => dec.decode({ vec: 'u8' }, r, 'v')).toThrow(/exceeds limit/);
  });
});

describe('normalization and quote denomination', () => {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  it('labels the quote asset SOL only when the quote mint is native or wrapped SOL', () => {
    const sol = synthEvent('pump', 'TradeEvent', { quote_mint: '11111111111111111111111111111111', is_buy: true });
    const n1 = normalizeEvent('TradeEvent', decoder.decode(PUMP_PROGRAM_ID, sol.payload).fields, now);
    expect(n1.quoteAsset).toBe('SOL');
    expect(n1.quoteAmount).toBe(sol.fields.quote_amount);
    expect(n1.direction).toBe('buy');

    // Synthetic analogue of the observed USDC-quoted case: sol_amount 0, amount in quote_amount.
    const usdc = synthEvent('pump', 'TradeEvent', { quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sol_amount: '0', quote_amount: '11177052' });
    const n2 = normalizeEvent('TradeEvent', decoder.decode(PUMP_PROGRAM_ID, usdc.payload).fields, now);
    expect(n2.quoteAsset).toBe('OTHER');
    expect(n2.quoteMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(n2.quoteAmount).toBe('11177052');
    expect(n2.reserveQuoteVirtual).toBe(usdc.fields.virtual_quote_reserves);
  });

  it('does not map a migration sol_amount to the quote amount for a non-SOL quote', () => {
    const m = synthEvent('pump', 'CompletePumpAmmMigrationEvent', { quote_mint: synthAddress('some-pump-coin') });
    const n1 = normalizeEvent('CompletePumpAmmMigrationEvent', m.fields, now);
    expect(n1.quoteAmount).toBeNull();
    expect(n1.warnings).toContain('sol_amount_not_mapped_for_non_sol_quote');
  });

  it('leaves PumpSwap mint and quote mint unknown (the events do not carry them)', () => {
    const b = synthEvent('pump_amm', 'BuyEvent');
    const n1 = normalizeEvent('BuyEvent', b.fields, now);
    expect(n1.mint).toBeNull();
    expect(n1.quoteMint).toBeNull();
    expect(n1.quoteAsset).toBeNull();
    expect(n1.pool).toBe(b.fields.pool);
  });

  it('flags implausible timestamps', () => {
    const t = synthEvent('pump', 'TradeEvent', { timestamp: '42' });
    const n1 = normalizeEvent('TradeEvent', t.fields, now);
    expect(n1.eventTimeSec).toBeNull();
    expect(n1.warnings.join()).toMatch(/implausible_timestamp/);
  });
});

describe('event extraction', () => {
  it('attributes "Program data" to the program on top of the invoke stack only', () => {
    const ev = synthEvent('pump', 'TradeEvent').payload;
    const foreign = Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9, 1]);
    const other = synthAddress('other-program');
    const logs = [
      `Program ${PUMP_PROGRAM_ID} invoke [1]`,
      `Program ${other} invoke [2]`,
      `Program data: ${b64(foreign)}`, // emitted by another program nested inside pump
      `Program ${other} success`,
      `Program data: ${b64(ev)}`,
      `Program ${PUMP_PROGRAM_ID} success`,
      `Program data: ${b64(ev)}`, // outside any invocation: ignored
    ];
    const s = scanLogs(logs, PROGRAMS);
    expect(s.candidates).toHaveLength(1);
    expect(s.candidates[0]!.programId).toBe(PUMP_PROGRAM_ID);
    expect(Buffer.from(s.candidates[0]!.payload)).toEqual(Buffer.from(ev));
    expect(s.truncated).toBe(false);
  });

  it('detects truncated logs', () => {
    expect(scanLogs([`Program ${PUMP_PROGRAM_ID} invoke [1]`, 'Log truncated'], PROGRAMS).truncated).toBe(true);
  });

  it('extracts emit_cpi inner instructions and merges their log copies by payload hash', () => {
    const a = synthEvent('pump', 'TradeEvent', { is_buy: true }).payload;
    const b = synthEvent('pump', 'TradeEvent', { is_buy: false }).payload;
    const tx = synthTx(100, PUMP_PROGRAM_ID, [a, b, a]);
    const inner = scanInnerInstructions(tx, PROGRAMS);
    expect(inner.candidates).toHaveLength(3);
    const logs = scanLogs(tx.meta!.logMessages!, PROGRAMS);
    const merged = mergeCandidates(inner.candidates, logs.candidates);
    expect(merged).toHaveLength(3); // the repeated payload is kept twice (occurrence 0 and 1)
    expect(merged.map((m) => m.occurrence)).toEqual([0, 0, 1]);
    expect(merged.every((m) => [...m.sources].sort().join('+') === 'cpi+log')).toBe(true);
  });

  it('ignores inner instructions of other programs and ones without the event tag', () => {
    const tx = synthTx(101, PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent').payload]);
    tx.meta!.innerInstructions![0]!.instructions.push({ programIdIndex: 1, data: encodeBase58(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])) });
    tx.meta!.innerInstructions![0]!.instructions.push({ programIdIndex: 0, data: encodeBase58(Uint8Array.from([...EVENT_IX_TAG, ...synthEvent('pump', 'TradeEvent').payload])) });
    expect(scanInnerInstructions(tx, PROGRAMS).candidates).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ database

describe('recordings.db v2 migration', () => {
  function v1WithRows() {
    const file = tmpDb('v1');
    const db = openRecorderDb(file, null);
    db.prepare("INSERT INTO recorder_runs (id, started_at, version, config_json) VALUES ('r1', 1, '0', '{}')").run();
    const ins = db.prepare(
      "INSERT INTO observations (run_id, poll_id, mint, fetched_at, poll_started_at, payload_json) VALUES ('r1', 'p1', ?, ?, ?, '{\"synthetic\":true}')",
    );
    for (let i = 0; i < 25; i++) ins.run(`mint-${i % 5}`, 1000 + i, 1000);
    db.prepare("INSERT INTO gaps (run_id, from_ts, to_ts, kind) VALUES ('r1', 1, 2, 'poll_gap')").run();
    return { file, db };
  }
  const v1Snapshot = (db: Database.Database) =>
    ['recorder_runs', 'polls', 'observations', 'rejections', 'gaps']
      .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))
      .join('|');

  it('is additive: v1 tables and rows are unchanged, schema_version becomes 2, and it is idempotent', () => {
    const { file, db } = v1WithRows();
    const before = v1Snapshot(db);
    const schemaBefore = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    db.close();
    const v2 = openOnchainDb(file, null, 5);
    expect(readSchemaVersion(v2)).toBe(2);
    expect(v1Snapshot(v2)).toBe(before);
    const schemaAfter = v2.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    for (const s of schemaBefore) expect(schemaAfter).toContainEqual(s); // v1 DDL untouched
    for (const t of ONCHAIN_TABLES) expect(schemaAfter.map((s) => s.name)).toContain(t);
    migrateToV2(v2, 6); // second run: no-op
    expect(readSchemaVersion(v2)).toBe(2);
    expect((v2.prepare("SELECT value FROM recorder_meta WHERE key = 'schema_v2_applied_at'").get() as { value: string }).value).toBe('5');
    expect(v1Snapshot(v2)).toBe(before);
    v2.close();
  });

  it('refuses an unknown future schema version', () => {
    const { file, db } = v1WithRows();
    db.prepare("UPDATE recorder_meta SET value = '3' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => openOnchainDb(file, null, 1)).toThrow(RecorderGuardError);
  });

  it('refuses the trading database path and any file with trading tables, without modifying it', () => {
    const paper = tmpDb('paper');
    const t = new Database(paper);
    t.exec("CREATE TABLE orders (id TEXT PRIMARY KEY); INSERT INTO orders VALUES ('o1');");
    t.close();
    const hash = () => createHash('sha256').update(readFileSync(paper)).digest('hex');
    const h0 = hash();
    expect(() => openOnchainDb(paper, paper, 1)).toThrow(RecorderGuardError);
    expect(() => openOnchainDb(paper, null, 1)).toThrow(/trading tables/);
    expect(hash()).toBe(h0);
  });
});

// ------------------------------------------------------------------ RPC client, budget, config

const LIMITS = { dailyCredits: 10_000, monthlyCredits: 100_000, dailyBytes: 50_000_000 };
const MODEL = { creditsPerRpcCall: 1, wsCreditsPer100Kb: 2, wsCreditsPerConnection: 1 };

describe('Helius RPC client', () => {
  const KEY = 'synthetic-test-key-0123456789';
  function client(fetchImpl: typeof fetch, limits = LIMITS) {
    const db = openDb(tmpDb('rpc'));
    const clock = new ManualClock();
    const budget = new UsageBudget(db, limits, MODEL, clock.now);
    const rpc = new HeliusRpc({ url: withApiKey('https://rpc.example.test/', KEY), apiKey: KEY, budget, fetchImpl, minIntervalMs: 100, sleep: async () => {}, clock: clock.now });
    return { rpc, budget };
  }

  it('only sends allowlisted read methods', async () => {
    const f = vi.fn();
    const { rpc } = client(f as unknown as typeof fetch);
    await expect(rpc.call('requestAirdrop', [])).rejects.toThrow(/allowlist/);
    expect(f).not.toHaveBeenCalled();
    expect([...ALLOWED_RPC_METHODS].sort()).toEqual(['getAccountInfo', 'getSignaturesForAddress', 'getTransaction']);
  });

  it('redacts the key from errors and never sends when the budget is exhausted', async () => {
    const failing = vi.fn(async (url: string) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    });
    const { rpc } = client(failing as unknown as typeof fetch);
    const err = await rpc.getSignaturesForAddress(synthAddress('m'), { limit: 1 }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(String((err as Error).message)).toContain('api-key=***');

    const f = vi.fn();
    const tiny = client(f as unknown as typeof fetch, { ...LIMITS, dailyCredits: 1 });
    tiny.budget.tryRpcCall(); // uses the single credit
    await expect(tiny.rpc.getTransaction(synthSignature('x'), 1)).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(f).not.toHaveBeenCalled();
  });

  it('retries HTTP 429 a bounded number of times, charging each attempt', async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      return calls < 3 ? new Response('busy', { status: 429 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
    });
    const { rpc, budget } = client(f as unknown as typeof fetch);
    await expect(rpc.getSignaturesForAddress(synthAddress('m'), { limit: 5 })).resolves.toEqual([]);
    expect(calls).toBe(3);
    expect(budget.today().rpc_calls).toBe(3);
    const always = vi.fn(async () => new Response('busy', { status: 429 }));
    const c2 = client(always as unknown as typeof fetch);
    await expect(c2.rpc.getSignaturesForAddress(synthAddress('m'), { limit: 5 })).rejects.toThrow(/429/);
    expect(always).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('sends read requests with confirmed commitment and json encoding', async () => {
    const bodies: unknown[] = [];
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
    });
    const { rpc } = client(f as unknown as typeof fetch);
    await rpc.getTransaction(synthSignature('t'), 1);
    expect(bodies[0]).toMatchObject({ method: 'getTransaction', params: [synthSignature('t'), { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }] });
  });
});

describe('usage budget', () => {
  it('persists per UTC day, enforces daily and monthly limits, and resets on a new day', () => {
    const db = openDb(tmpDb('budget'));
    const clock = new ManualClock(Date.UTC(2026, 5, 30, 23, 0, 0));
    const b = new UsageBudget(db, { dailyCredits: 3, monthlyCredits: 5, dailyBytes: 1_000_000 }, MODEL, clock.now);
    expect(b.tryRpcCall()).toBe(true);
    expect(b.tryRpcCall()).toBe(true);
    expect(b.tryRpcCall()).toBe(true);
    expect(b.tryRpcCall()).toBe(false);
    expect(b.check()).toEqual({ ok: true });
    const again = new UsageBudget(db, b.limits, MODEL, clock.now); // restart keeps counting
    expect(again.tryRpcCall()).toBe(false);
    clock.advance(msUntilNextUtcDay(clock.now()) + 1); // July: new day and new month
    expect(again.tryRpcCall()).toBe(true);
    expect(again.today().day).toBe('2026-07-01');
  });

  it('counts WebSocket bytes as credits and reports the bandwidth limit', () => {
    const db = openDb(tmpDb('budget'));
    const clock = new ManualClock();
    const b = new UsageBudget(db, { dailyCredits: 1000, monthlyCredits: 1000, dailyBytes: 300_000 }, MODEL, clock.now);
    expect(b.recordWsBytes(102_400).ok).toBe(true);
    expect(b.today().credits).toBe(2);
    const st = b.recordWsBytes(250_000);
    expect(st.ok).toBe(false);
  });
});

describe('on-chain config', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', RECORDER_DATABASE_URL: `sqlite:${join(dir, 'cfg.db')}` };
  it('is disabled when HELIUS_API_KEY is absent and never exposes the key', () => {
    expect(loadOnchainConfig(base).enabled).toBe(false);
    const c = loadOnchainConfig({ ...base, HELIUS_API_KEY: 'synthetic-secret-value', HELIUS_RPC_URL: 'https://rpc.example.test/?api-key=embedded-secret', ONCHAIN_WATCHLIST: synthAddress('w') });
    expect(c.enabled).toBe(true);
    const text = JSON.stringify(describeConfig(c));
    expect(text).not.toContain('synthetic-secret-value');
    expect(text).not.toContain('embedded-secret');
    expect(redact('wss://x/?api-key=abc&x=1')).toBe('wss://x/?api-key=***&x=1');
  });

  it('rejects invalid watchlist addresses and wallet-style variables', () => {
    expect(() => loadOnchainConfig({ ...base, ONCHAIN_WATCHLIST: 'nope' })).toThrow(/invalid addresses/);
    expect(() => loadOnchainConfig({ ...base, PRIVATE_KEY: 'x' })).toThrow(/Refusing to start/);
  });
});

// ------------------------------------------------------------------ recorder (fake WebSocket + fake RPC)

const KEY = 'synthetic-ws-key-abcdef123456';
const MINT_A = synthAddress('mint-a');
const MINT_B = synthAddress('mint-b');

function setup(over: { limits?: typeof LIMITS; backfillMaxSignatures?: number; backfillOnStart?: boolean; file?: string; subscriptions?: string[] } = {}) {
  const file = over.file ?? tmpDb('onchain');
  const db = openDb(file);
  const clock = new ManualClock();
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
    subscriptions: over.subscriptions ?? [MINT_A, MINT_B],
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
    backfillMaxSignatures: over.backfillMaxSignatures ?? 100,
    backfillOnStart: over.backfillOnStart ?? true,
    storeRaw: 'all',
    maxTxVersion: 1,
    runConfig: { synthetic: true },
  });
  const runTimer = () => {
    const t = timers.filter((x) => !x.cancelled).shift();
    if (!t) throw new Error('no pending timer');
    t.cancelled = true;
    t.fn();
    return t.ms;
  };
  return { db, file, clock, budget, sockets, timers, logs, rpc, rec, runTimer };
}
const count = (db: Database.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

describe('on-chain recorder', () => {
  it('subscribes once per address with logsSubscribe/mentions at confirmed commitment', () => {
    const { rec, sockets, logs } = setup();
    rec.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [MINT_A] }, { commitment: 'confirmed' }] },
      { jsonrpc: '2.0', id: 2, method: 'logsSubscribe', params: [{ mentions: [MINT_B] }, { commitment: 'confirmed' }] },
    ]);
    sockets[0]!.confirmAll();
    expect(rec.status).toBe('live');
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('stores a decoded event once even when the transaction is notified on two subscriptions', () => {
    const { rec, sockets, db } = setup();
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    const ev = synthEvent('pump', 'TradeEvent', { mint: MINT_A, quote_mint: '11111111111111111111111111111111', is_buy: true });
    const sig = synthSignature('dup');
    const logs = ixLogs(PUMP_PROGRAM_ID, [ev.payload]);
    sockets[0]!.notify(subs.get(MINT_A)!, sig, 500, logs);
    sockets[0]!.notify(subs.get(MINT_B)!, sig, 500, logs);
    const rows = db.prepare('SELECT * FROM chain_events').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signature: sig, slot: 500, event_type: 'TradeEvent', decode_status: 'ok', mint: MINT_A, mint_source: 'event', direction: 'buy',
      base_amount: ev.fields.token_amount, quote_amount: ev.fields.quote_amount, quote_asset: 'SOL', sources: 'log', decoder_version: DECODER_VERSION,
      event_time: Number(SYNTH_TS), event_index: 0, occurrence: 0,
    });
    expect(JSON.parse(rows[0]!.fields_json as string).sol_amount).toBe(ev.fields.sol_amount);
    expect(rec.stats.duplicateNotifications).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM onchain_raw_messages')).toBe(1);
  });

  it('skips failed transactions and quarantines payloads with unknown trailing bytes', () => {
    const { rec, sockets, db } = setup();
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    const ev = synthEvent('pump', 'TradeEvent', { mint: MINT_A });
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('failed'), 501, ixLogs(PUMP_PROGRAM_ID, [ev.payload]), { InstructionError: [0, 'Custom'] });
    expect(count(db, 'SELECT COUNT(*) AS n FROM chain_events')).toBe(0);
    expect(rec.stats.failedTxSkipped).toBe(1);

    const longer = Uint8Array.from([...ev.payload, 1, 2, 3, 4, 5, 6, 7, 8]);
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('trailing'), 502, ixLogs(PUMP_PROGRAM_ID, [longer]));
    expect(count(db, 'SELECT COUNT(*) AS n FROM chain_events')).toBe(0);
    const q = db.prepare('SELECT * FROM onchain_quarantine').all() as Record<string, unknown>[];
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ event_type: 'TradeEvent', decode_status: 'ok_trailing' });
    expect(q[0]!.diagnostic).toMatch(/8 unknown trailing bytes/);
    expect(count(db, "SELECT COUNT(*) AS n FROM onchain_errors WHERE kind = 'quarantined'")).toBe(1);
  });

  it('records unknown discriminators as errors, not events', () => {
    const { rec, sockets, db } = setup();
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('unknown'), 503, ixLogs(PUMP_PROGRAM_ID, [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0])]));
    expect(count(db, 'SELECT COUNT(*) AS n FROM chain_events')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM onchain_errors WHERE kind = 'unknown_discriminator'")).toBe(1);
  });

  it('resolves PumpSwap trade mint and quote mint from a recorded CreatePoolEvent', () => {
    const { rec, sockets, db } = setup();
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    const pool = synthAddress('pool-1');
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const buyBefore = synthEvent('pump_amm', 'BuyEvent', { pool });
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('buy-before'), 600, ixLogs(PUMP_AMM_PROGRAM_ID, [buyBefore.payload]));
    const create = synthEvent('pump_amm', 'CreatePoolEvent', { pool, base_mint: MINT_A, quote_mint: usdc });
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('create-pool'), 601, ixLogs(PUMP_AMM_PROGRAM_ID, [create.payload]));
    const sell = synthEvent('pump_amm', 'SellEvent', { pool });
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('sell-after'), 602, ixLogs(PUMP_AMM_PROGRAM_ID, [sell.payload]));
    const rows = db.prepare('SELECT event_type, mint, mint_source, quote_mint, quote_asset, direction FROM chain_events ORDER BY slot').all();
    expect(rows).toEqual([
      { event_type: 'BuyEvent', mint: null, mint_source: null, quote_mint: null, quote_asset: null, direction: 'buy' },
      { event_type: 'CreatePoolEvent', mint: MINT_A, mint_source: 'event', quote_mint: usdc, quote_asset: 'OTHER', direction: null },
      { event_type: 'SellEvent', mint: MINT_A, mint_source: 'pool:onchain_event', quote_mint: usdc, quote_asset: 'OTHER', direction: 'sell' },
    ]);
  });

  it('opens gaps on disconnect, reconnects with backoff, and marks a complete backfill verified', async () => {
    const { rec, sockets, db, rpc, runTimer } = setup({ subscriptions: [MINT_A] });
    rec.start();
    sockets[0]!.open();
    let subs = sockets[0]!.confirmAll();
    const seenSig = synthSignature('seen-before-gap');
    sockets[0]!.notify(subs.get(MINT_A)!, seenSig, 700, ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent', { mint: MINT_A }).payload]));

    sockets[0]!.serverDrop();
    expect(rec.status).toBe('reconnecting');
    const gap = db.prepare('SELECT * FROM onchain_gaps').get() as Record<string, unknown>;
    expect(gap).toMatchObject({ subscription: MINT_A, kind: 'disconnect', status: 'open', last_signature: seenSig, last_slot: 700, to_ts: null });
    expect(runTimer()).toBe(1000); // first backoff step

    const missed = synthSignature('missed-during-gap');
    const missedEv = synthEvent('pump', 'TradeEvent', { mint: MINT_A, is_buy: false });
    rpc.sigPages = [[{ signature: missed, slot: 705, err: null }, { signature: synthSignature('failed-in-gap'), slot: 704, err: { x: 1 } }]];
    rpc.txs.set(missed, synthTx(705, PUMP_PROGRAM_ID, [missedEv.payload]));
    sockets[1]!.open();
    subs = sockets[1]!.confirmAll(200);
    await rec.idle();

    expect(rpc.sigCalls).toEqual([{ address: MINT_A, until: seenSig, before: undefined, limit: 100 }]);
    expect(rpc.txCalls).toEqual([missed]); // the failed transaction is not fetched
    const g = db.prepare('SELECT * FROM onchain_gaps').get() as Record<string, unknown>;
    expect(g).toMatchObject({ status: 'backfilled_verified', backfill_signatures: 2, backfill_transactions: 1, backfill_events: 1 });
    expect(g.to_ts).not.toBeNull();
    const ev = db.prepare('SELECT sources, block_time, direction FROM chain_events WHERE signature = ?').get(missed);
    expect(ev).toEqual({ sources: 'cpi+log', block_time: Number(SYNTH_TS), direction: 'sell' });
  });

  it('does not refetch a transaction already seen live, and dedupes live vs backfill copies', async () => {
    const { rec, sockets, db, rpc, runTimer } = setup({ subscriptions: [MINT_A] });
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    const before = synthSignature('before');
    sockets[0]!.notify(subs.get(MINT_A)!, before, 800, ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent', { mint: MINT_A }).payload]));
    sockets[0]!.serverDrop();
    runTimer();
    const live = synthSignature('live-after-reconnect');
    const liveEv = synthEvent('pump', 'TradeEvent', { mint: MINT_A, is_buy: true });
    rpc.sigPages = [[{ signature: live, slot: 810, err: null }]];
    rpc.txs.set(live, synthTx(810, PUMP_PROGRAM_ID, [liveEv.payload]));
    const ws = sockets[1]!;
    ws.open();
    const s2 = ws.confirmAll(300);
    // The live notification arrives before the queued backfill runs (it starts on a later tick).
    ws.notify(s2.get(MINT_A)!, live, 810, ixLogs(PUMP_PROGRAM_ID, [liveEv.payload]));
    await rec.idle();
    expect(rpc.txCalls).toEqual([]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM chain_events WHERE signature = ?', live)).toBe(1);
    expect((db.prepare('SELECT status FROM onchain_gaps').get() as { status: string }).status).toBe('backfilled_verified');
  });

  it('never claims verification when the signature cap is reached, a fetch fails, or there is no cursor', async () => {
    // cap reached
    const a = setup({ subscriptions: [MINT_A], backfillMaxSignatures: 1 });
    a.rec.start();
    a.sockets[0]!.open();
    let subs = a.sockets[0]!.confirmAll();
    a.sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('a0'), 900, []);
    a.sockets[0]!.serverDrop();
    a.runTimer();
    a.rpc.sigPages = [[{ signature: synthSignature('a1'), slot: 901, err: null }]];
    a.rpc.txs.set(synthSignature('a1'), synthTx(901, PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent').payload]));
    a.sockets[1]!.open();
    a.sockets[1]!.confirmAll(10);
    await a.rec.idle();
    expect(a.db.prepare('SELECT status, note FROM onchain_gaps').get()).toMatchObject({ status: 'backfill_partial', note: expect.stringMatching(/cap 1/) });

    // fetch returns null
    const b = setup({ subscriptions: [MINT_A] });
    b.rec.start();
    b.sockets[0]!.open();
    subs = b.sockets[0]!.confirmAll();
    b.sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('b0'), 900, []);
    b.sockets[0]!.serverDrop();
    b.runTimer();
    b.rpc.sigPages = [[{ signature: synthSignature('b1'), slot: 901, err: null }]];
    b.sockets[1]!.open();
    b.sockets[1]!.confirmAll(10);
    await b.rec.idle();
    expect((b.db.prepare('SELECT status FROM onchain_gaps').get() as { status: string }).status).toBe('backfill_partial');

    // no cursor before the gap
    const c = setup({ subscriptions: [MINT_A] });
    c.rec.start();
    c.sockets[0]!.open();
    c.sockets[0]!.confirmAll();
    c.sockets[0]!.serverDrop();
    c.runTimer();
    c.sockets[1]!.open();
    c.sockets[1]!.confirmAll(10);
    await c.rec.idle();
    expect((c.db.prepare('SELECT status FROM onchain_gaps').get() as { status: string }).status).toBe('unverifiable');
    expect(c.rpc.sigCalls).toHaveLength(0);
  });

  it('paginates signature listings with before= and stops at the until boundary', async () => {
    const { rec, sockets, db, rpc, runTimer } = setup({ subscriptions: [MINT_A], backfillMaxSignatures: 2500 });
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('p0'), 1, []);
    sockets[0]!.serverDrop();
    runTimer();
    const page = (k: number, len: number) => Array.from({ length: len }, (_, i) => ({ signature: synthSignature(`p${k}-${i}`), slot: 10, err: { failed: true } }));
    rpc.sigPages = [page(1, 1000), page(2, 1000), page(3, 10)];
    sockets[1]!.open();
    sockets[1]!.confirmAll(10);
    await rec.idle();
    expect(rpc.sigCalls.map((c) => [c.limit, c.before])).toEqual([
      [1000, undefined],
      [1000, synthSignature('p1-999')],
      [500, synthSignature('p2-999')],
    ]);
    expect((db.prepare('SELECT status, backfill_signatures FROM onchain_gaps').get() as Record<string, unknown>)).toEqual({ status: 'backfilled_verified', backfill_signatures: 2010 });
  });

  it('pauses on budget exhaustion: closes the socket, opens budget gaps, schedules resume at the UTC day boundary', async () => {
    const { rec, sockets, db, timers, rpc } = setup({ limits: { dailyCredits: 10_000, monthlyCredits: 100_000, dailyBytes: 2_000 } });
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    const big = synthEvent('pump', 'TradeEvent', { mint: MINT_A });
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('big'), 1000, ixLogs(PUMP_PROGRAM_ID, [big.payload, big.payload, big.payload]));
    expect(rec.status).toBe('paused_budget');
    expect(sockets[0]!.closed).toMatchObject({ code: 1000 });
    expect(count(db, "SELECT COUNT(*) AS n FROM onchain_gaps WHERE kind = 'budget_pause' AND status = 'open'")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM onchain_errors WHERE kind = 'budget'")).toBe(1);
    const pending = timers.filter((t) => !t.cancelled);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ms).toBeGreaterThan(0);
    expect(rpc.sigCalls).toHaveLength(0);
    expect(sockets).toHaveLength(1); // no reconnect while paused
    await rec.stop('test');
  });

  it('refuses to connect when the daily budget is already spent', () => {
    const { rec, sockets, budget } = setup({ limits: { dailyCredits: 1, monthlyCredits: 100, dailyBytes: 1_000_000 } });
    budget.tryRpcCall();
    rec.start();
    expect(sockets).toHaveLength(0);
    expect(rec.status).toBe('paused_budget');
  });

  it('records a between-sessions gap for addresses with a cursor and backfills it on start', async () => {
    const file = tmpDb('sessions');
    const first = setup({ file, subscriptions: [MINT_A] });
    first.rec.start();
    first.sockets[0]!.open();
    const subs = first.sockets[0]!.confirmAll();
    first.sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('s1'), 50, []);
    await first.rec.stop('test');
    expect(first.db.prepare('SELECT stop_reason, stopped_at FROM onchain_sessions').get()).toMatchObject({ stop_reason: 'test' });
    first.db.close();

    const second = setup({ file, subscriptions: [MINT_A] });
    second.rec.start();
    expect(count(second.db, "SELECT COUNT(*) AS n FROM onchain_gaps WHERE kind = 'between_sessions' AND last_signature = ?", synthSignature('s1'))).toBe(1);
    second.rpc.sigPages = [[]];
    second.sockets[0]!.open();
    second.sockets[0]!.confirmAll();
    await second.rec.idle();
    expect((second.db.prepare("SELECT status FROM onchain_gaps WHERE kind = 'between_sessions'").get() as { status: string }).status).toBe('backfilled_verified');
  });

  it('reconnects when a subscription is rejected instead of running without it', () => {
    const { rec, sockets, runTimer } = setup();
    rec.start();
    sockets[0]!.open();
    sockets[0]!.msg({ jsonrpc: '2.0', id: 1, result: 11 });
    sockets[0]!.msg({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'synthetic rejection' } });
    expect(sockets[0]!.closed).toMatchObject({ code: 4000 });
    expect(rec.status).toBe('reconnecting');
    runTimer();
    expect(sockets).toHaveLength(2);
  });

  it('reconnects after a connection failure reported by error only (Node 22 sends no close event)', () => {
    const { rec, sockets, runTimer, db } = setup();
    rec.start();
    sockets[0]!.onerror?.({ message: 'Received network error or non-101 status code.' });
    expect(rec.status).toBe('reconnecting');
    expect(count(db, "SELECT COUNT(*) AS n FROM onchain_gaps WHERE kind = 'disconnect' AND status = 'open'")).toBe(2);
    expect(runTimer()).toBe(1000);
    expect(sockets).toHaveLength(2);
  });

  it('treats a socket that never opens as failed after the connect timeout', () => {
    const { rec, sockets, timers } = setup();
    rec.start();
    const timeout = timers.find((t) => !t.cancelled && t.ms === 30_000)!;
    expect(timeout).toBeDefined();
    timeout.cancelled = true;
    timeout.fn();
    expect(rec.status).toBe('reconnecting');
    expect(sockets[0]!.closed).not.toBeNull();
  });

  it('uses exponential backoff with a cap, and redacts the key from close reasons', () => {
    const { rec, sockets, runTimer, logs, db } = setup();
    rec.start();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      sockets[sockets.length - 1]!.onclose?.({ code: 1006, reason: `boom api-key=${KEY}` });
      delays.push(runTimer());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(db.prepare('SELECT detail FROM onchain_errors').all())).not.toContain(KEY);
  });

  it('fetches the transaction when live logs are truncated', async () => {
    const { rec, sockets, db, rpc } = setup();
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    const sig = synthSignature('truncated');
    const ev = synthEvent('pump', 'TradeEvent', { mint: MINT_A });
    rpc.txs.set(sig, synthTx(1200, PUMP_PROGRAM_ID, [ev.payload], { logs: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, 'Log truncated'] }));
    sockets[0]!.notify(subs.get(MINT_A)!, sig, 1200, [`Program ${PUMP_PROGRAM_ID} invoke [1]`, 'Log truncated']);
    await rec.idle();
    expect(rpc.txCalls).toEqual([sig]);
    expect(db.prepare('SELECT sources FROM chain_events WHERE signature = ?').get(sig)).toEqual({ sources: 'cpi' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM onchain_raw_messages WHERE signature = ? AND complete = 0', sig)).toBe(0);
  });

  it('the report summarises events, quarantine, gaps and usage read-only', () => {
    const { rec, sockets, file } = setup();
    rec.start();
    sockets[0]!.open();
    const subs = sockets[0]!.confirmAll();
    sockets[0]!.notify(subs.get(MINT_A)!, synthSignature('r1'), 1, ixLogs(PUMP_PROGRAM_ID, [synthEvent('pump', 'TradeEvent', { mint: MINT_A }).payload]));
    const ro = new Database(file, { readonly: true });
    const r = buildOnchainReport(ro, Date.UTC(2026, 5, 1), LIMITS);
    ro.close();
    expect(r.migrated).toBe(true);
    expect(r.events).toEqual([{ event_type: 'TradeEvent', decode_status: 'ok', n: 1 }]);
    expect(formatOnchainReport(r)).toMatch(/Quarantined/);
  });
});
