/**
 * recordings.db schema v2: additive tables for on-chain events.
 *
 * The migration only runs CREATE TABLE / CREATE INDEX IF NOT EXISTS plus a recorder_meta update,
 * in one transaction. It never alters, drops or rewrites a v1 table or row. It is reached only
 * through openRecorderDb(), so the paper-trading database guard always runs first.
 */
import type Database from 'better-sqlite3';
import { RecorderGuardError, openRecorderDb } from '../recorder/db';

export const ONCHAIN_SCHEMA_VERSION = 2;

const V2_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS onchain_sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    stop_reason TEXT,                   -- NULL while running; 'crashed_or_killed' when found unclosed by a later session
    last_alive_at INTEGER,              -- last time this session had evidence of a live connection (throttled)
    decoder_version TEXT NOT NULL,
    config_json TEXT NOT NULL           -- never contains the API key
  )`,
  // One row per confirmed logsSubscribe: the only source of truth for on-chain coverage.
  `CREATE TABLE IF NOT EXISTS onchain_subscription_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    mint TEXT NOT NULL,
    started_at INTEGER NOT NULL,        -- server confirmed the subscription (ms)
    last_alive_at INTEGER NOT NULL,     -- last inbound message on this connection while subscribed (ms)
    ended_at INTEGER,                   -- when the recorder observed the end; NULL = still active, or end unknown (crash)
    end_reason TEXT                     -- unsubscribed | session_stopped | budget_pause | disconnect | stale | subscribe_failed | session_crashed
  )`,
  `CREATE INDEX IF NOT EXISTS idx_onchain_sub_periods_mint ON onchain_subscription_periods (mint, started_at)`,
  // Conservative coverage: periods the recorder ended itself are covered until ended_at; periods
  // that ended by connection loss or an unknown crash only until the last proof of life.
  `CREATE VIEW IF NOT EXISTS onchain_coverage AS
    SELECT id, session_id, mint, started_at,
      CASE WHEN end_reason IN ('unsubscribed', 'session_stopped', 'budget_pause') THEN ended_at ELSE last_alive_at END AS covered_until,
      ended_at, end_reason,
      CASE WHEN ended_at IS NULL AND end_reason IS NULL THEN 'active'
           WHEN end_reason = 'session_crashed' THEN 'end_unknown'
           WHEN end_reason IN ('unsubscribed', 'session_stopped', 'budget_pause') THEN 'clean'
           ELSE 'lost' END AS end_kind
    FROM onchain_subscription_periods`,
  `CREATE TABLE IF NOT EXISTS onchain_raw_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,       -- ms, local clock at receipt
    source TEXT NOT NULL,               -- ws_logs | rpc_transaction
    signature TEXT,
    slot INTEGER,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 1, -- 0: events may be missing (truncated logs, tx not fetched)
    payload TEXT                        -- raw JSON text; NULL when ONCHAIN_STORE_RAW does not keep it
  )`,
  `CREATE INDEX IF NOT EXISTS idx_onchain_raw_sig ON onchain_raw_messages (signature)`,
  `CREATE TABLE IF NOT EXISTS chain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    raw_message_id INTEGER,             -- onchain_raw_messages.id of the first message that yielded it
    signature TEXT NOT NULL,
    slot INTEGER NOT NULL,
    block_time INTEGER,                 -- s, from getTransaction when known
    event_index INTEGER NOT NULL,       -- position among decoded events of the transaction
    occurrence INTEGER NOT NULL,        -- n-th identical payload within the transaction
    sources TEXT NOT NULL,              -- log | cpi | cpi+log
    program_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    decode_status TEXT NOT NULL,        -- always 'ok' (exact layout match); other layouts go to onchain_quarantine
    decoder_version TEXT NOT NULL,
    event_time INTEGER,                 -- s, event's own timestamp field (NULL if absent/implausible)
    event_time_raw TEXT,                -- exact i64 as emitted
    received_at INTEGER NOT NULL,       -- ms, local clock at receipt
    commitment TEXT NOT NULL,
    mint TEXT,
    mint_source TEXT,                   -- event | pool:<method> | NULL (unresolved; see chain_events_resolved)
    bonding_curve TEXT,
    pool TEXT,
    user_address TEXT,
    direction TEXT,                     -- buy | sell | NULL
    base_amount TEXT,                   -- exact integer strings in raw base units
    quote_amount TEXT,
    quote_mint TEXT,                    -- NULL when unknown (e.g. PumpSwap pool not yet mapped)
    quote_asset TEXT,                   -- SOL only when quote_mint is native/wrapped SOL; OTHER; NULL = unknown
    reserve_base_virtual TEXT,
    reserve_quote_virtual TEXT,
    reserve_base_real TEXT,
    reserve_quote_real TEXT,
    fees_json TEXT NOT NULL DEFAULT '{}',
    fields_json TEXT NOT NULL,          -- every decoded field, exact
    missing_fields_json TEXT NOT NULL DEFAULT '[]',
    trailing_bytes INTEGER NOT NULL DEFAULT 0,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    payload_hash TEXT NOT NULL,         -- sha256 of discriminator + borsh bytes
    payload_b64 TEXT NOT NULL,
    UNIQUE (signature, payload_hash, occurrence)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chain_events_mint_slot ON chain_events (mint, slot)`,
  `CREATE INDEX IF NOT EXISTS idx_chain_events_pool_slot ON chain_events (pool, slot)`,
  `CREATE INDEX IF NOT EXISTS idx_chain_events_type ON chain_events (event_type)`,
  `CREATE TABLE IF NOT EXISTS onchain_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- decode_error | unknown_discriminator | log_truncated | log_problem | ws_error | rpc_error | budget
    signature TEXT,
    program_id TEXT,
    detail TEXT NOT NULL,
    raw_message_id INTEGER,
    payload_b64 TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_onchain_errors_kind ON onchain_errors (kind)`,
  `CREATE TABLE IF NOT EXISTS onchain_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    signature TEXT NOT NULL,
    slot INTEGER NOT NULL,
    program_id TEXT NOT NULL,
    event_type TEXT,
    decode_status TEXT NOT NULL,        -- ok_trailing | partial (layout does not match the pinned IDL exactly)
    decoder_version TEXT NOT NULL,
    diagnostic TEXT NOT NULL,
    fields_json TEXT NOT NULL,          -- what could be decoded, for later re-processing
    payload_hash TEXT NOT NULL,
    payload_b64 TEXT NOT NULL,
    raw_message_id INTEGER,
    UNIQUE (signature, payload_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS onchain_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    subscription TEXT NOT NULL,         -- watched mint address
    kind TEXT NOT NULL,                 -- disconnect | budget_pause | between_sessions
    from_ts INTEGER NOT NULL,
    to_ts INTEGER,                      -- NULL while still open
    last_signature TEXT,                -- newest signature seen before the gap (backfill 'until')
    last_slot INTEGER,
    status TEXT NOT NULL,               -- open | backfilled_verified | backfill_partial | backfill_failed | unverifiable
    backfill_signatures INTEGER NOT NULL DEFAULT 0,
    backfill_transactions INTEGER NOT NULL DEFAULT 0,
    backfill_events INTEGER NOT NULL DEFAULT 0,
    backfill_at INTEGER,
    note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_onchain_gaps_status ON onchain_gaps (status)`,
  `CREATE TABLE IF NOT EXISTS onchain_cursors (
    subscription TEXT PRIMARY KEY,
    last_signature TEXT NOT NULL,
    last_slot INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS onchain_pools (
    pool TEXT PRIMARY KEY,
    status TEXT NOT NULL,               -- resolved | unresolved (may retry) | unresolvable | conflict
    base_mint TEXT,                     -- set only when status = resolved
    quote_mint TEXT,
    method TEXT,                        -- onchain_event | instruction_accounts | pool_account
    detail TEXT,                        -- evidence or the reason it is not resolved
    reported_by TEXT,                   -- e.g. 'dexscreener' when a third party suggested this pool (never trusted alone)
    attempts INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS onchain_watchlist (
    mint TEXT PRIMARY KEY,
    source TEXT NOT NULL,               -- static | dexscreener
    status TEXT NOT NULL,               -- active | pending (over capacity) | evicted
    lifecycle TEXT NOT NULL,            -- bonding_curve | complete | migrated | unknown
    lifecycle_source TEXT,              -- onchain_event | pool_account | dexscreener_reported
    dex_id TEXT,                        -- as last reported by DexScreener
    pair_address TEXT,                  -- as last reported by DexScreener (unverified)
    pool TEXT,                          -- PumpSwap pool, only once verified on-chain
    pair_created_at INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_discovered_at INTEGER,
    last_event_at INTEGER,
    activated_at INTEGER,
    first_subscribed_at INTEGER,        -- on-chain coverage for this mint starts here
    evicted_at INTEGER,
    evict_reason TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_onchain_watchlist_status ON onchain_watchlist (status)`,
  `CREATE TABLE IF NOT EXISTS onchain_watch_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    from_ts INTEGER NOT NULL,
    to_ts INTEGER,                      -- NULL while watched
    end_reason TEXT                     -- idle | capacity | removed | session_stopped
  )`,
  `CREATE INDEX IF NOT EXISTS idx_onchain_watch_periods_mint ON onchain_watch_periods (mint)`,
  // Read-time resolution of PumpSwap mints; chain_events rows are never rewritten.
  `CREATE VIEW IF NOT EXISTS chain_events_resolved AS
    SELECT e.*,
      COALESCE(e.mint, p.base_mint) AS resolved_mint,
      CASE WHEN e.mint IS NOT NULL THEN e.mint_source WHEN p.base_mint IS NOT NULL THEN 'pool:' || p.method ELSE NULL END AS resolved_mint_source,
      COALESCE(e.quote_mint, p.quote_mint) AS resolved_quote_mint
    FROM chain_events e
    LEFT JOIN onchain_pools p ON p.pool = e.pool AND p.status = 'resolved'`,
  `CREATE TABLE IF NOT EXISTS onchain_usage (
    day TEXT PRIMARY KEY,               -- UTC yyyy-mm-dd
    credits INTEGER NOT NULL DEFAULT 0, -- estimated with the configured credit model
    ws_bytes INTEGER NOT NULL DEFAULT 0,
    rpc_bytes INTEGER NOT NULL DEFAULT 0,
    rpc_calls INTEGER NOT NULL DEFAULT 0,
    ws_connections INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
];

export const ONCHAIN_TABLES = [
  'onchain_sessions', 'onchain_raw_messages', 'chain_events', 'onchain_errors', 'onchain_quarantine',
  'onchain_gaps', 'onchain_subscription_periods', 'onchain_cursors', 'onchain_pools', 'onchain_watchlist', 'onchain_watch_periods', 'onchain_usage',
];

export function readSchemaVersion(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM recorder_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

/** Applies the additive v2 tables to an already-guarded, v1-initialised recordings database. */
export function migrateToV2(db: Database.Database, now: number): void {
  const version = readSchemaVersion(db);
  if (version !== 1 && version !== 2) {
    throw new RecorderGuardError(`Refusing to migrate: recordings schema_version is ${version}; this build understands 1 and 2.`);
  }
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') throw new RecorderGuardError(`Refusing to migrate: quick_check reported ${String(check)}`);
  db.transaction(() => {
    for (const stmt of V2_SCHEMA) db.exec(stmt);
    db.prepare("UPDATE recorder_meta SET value = ? WHERE key = 'schema_version' AND value = '1'").run(String(ONCHAIN_SCHEMA_VERSION));
    const add = db.prepare('INSERT INTO recorder_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING');
    add.run('schema_v2_applied_at', String(now));
    add.run('schema_v2_note', 'Additive: on-chain event tables (Helius). v1 DexScreener tables unchanged.');
  })();
}

/** Opens recordings.db for the on-chain recorder: trading-DB guard, v1 init, then v2 migration. */
export function openOnchainDb(recPath: string, tradingDbPath: string | null, now: number): Database.Database {
  const db = openRecorderDb(recPath, tradingDbPath);
  try {
    migrateToV2(db, now);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
