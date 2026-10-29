import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export class RecorderGuardError extends Error {}

/** Tables that identify a paper-trading database. The recorder refuses to open such a file. */
const TRADING_TABLES = ['orders', 'positions', 'kv', 'audit_log', 'equity_snapshots'];

export const RECORDER_SCHEMA_VERSION = 1;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS recorder_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS recorder_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    stop_reason TEXT,
    version TEXT NOT NULL,
    config_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    poll_started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    status TEXT NOT NULL,              -- ok | cached | failed
    tokens_tracked INTEGER,
    observations INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    rate_limited_until INTEGER,
    warnings_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_polls_started ON polls (poll_started_at)`,
  `CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    poll_id TEXT NOT NULL,
    mint TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,       -- when this app received the data
    poll_started_at INTEGER NOT NULL,  -- shared by every row of one poll
    source_ts INTEGER,                 -- per-record source timestamp: DexScreener provides none (NULL)
    pair_created_at INTEGER,           -- token age only; never a market-update time
    pair_address TEXT,
    dex_id TEXT,
    symbol TEXT,
    price_sol REAL,
    price_usd REAL,
    quote_reserve_sol REAL,
    base_reserve REAL,
    liquidity_usd REAL,
    volume_5m_sol REAL,
    volume_1h_sol REAL,
    buys_5m INTEGER,
    sells_5m INTEGER,
    price_change_5m_pct REAL,
    price_change_1h_pct REAL,
    payload_json TEXT NOT NULL,        -- full validated MarketObservation
    UNIQUE (mint, fetched_at)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_obs_mint_time ON observations (mint, fetched_at)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_poll_time ON observations (poll_started_at)`,
  `CREATE TABLE IF NOT EXISTS rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    mint TEXT,
    reason TEXT NOT NULL,
    raw_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    from_ts INTEGER NOT NULL,
    to_ts INTEGER NOT NULL,
    kind TEXT NOT NULL                 -- poll_gap (within a run) | between_runs
  )`,
];

function canonical(p: string): string {
  const abs = resolve(p);
  const real = existsSync(abs) ? realpathSync.native(abs) : abs;
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Refuses (throws) if `recPath` is the paper-trading database, or is any existing SQLite file
 * that contains trading tables. Opens nothing for writing.
 */
export function assertNotTradingDb(recPath: string, tradingDbPath: string | null): void {
  if (tradingDbPath && canonical(recPath) === canonical(tradingDbPath)) {
    throw new RecorderGuardError(`Refusing to start: the recorder database resolves to the trading database (${tradingDbPath}).`);
  }
  if (existsSync(recPath)) {
    const probe = new Database(recPath, { readonly: true, fileMustExist: true });
    try {
      const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      const hit = tables.filter((t) => TRADING_TABLES.includes(t));
      if (hit.length) {
        throw new RecorderGuardError(`Refusing to start: ${recPath} contains trading tables (${hit.join(', ')}). It is not a recordings database.`);
      }
    } finally {
      probe.close();
    }
  }
}

/** Opens (creating if needed) the recorder's own database after the trading-database guard. */
export function openRecorderDb(recPath: string, tradingDbPath: string | null): Database.Database {
  assertNotTradingDb(recPath, tradingDbPath);
  mkdirSync(dirname(resolve(recPath)), { recursive: true });
  const db = new Database(recPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    for (const stmt of SCHEMA) db.exec(stmt);
    const upsert = db.prepare('INSERT INTO recorder_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING');
    upsert.run('schema_version', String(RECORDER_SCHEMA_VERSION));
    upsert.run('purpose', 'Read-only DexScreener market-data recordings for research. Not trading data; no orders or balances.');
    upsert.run('created_at', String(Date.now()));
  })();
  return db;
}
