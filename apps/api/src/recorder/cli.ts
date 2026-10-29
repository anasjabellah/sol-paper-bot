/**
 * Market-data recorder CLI (separate process; never starts the API or the bot).
 *
 *   npm run record                       record real DexScreener data to RECORDER_DATABASE_URL
 *   npm run record -- --keep-awake       same, and ask Windows not to sleep while it runs
 *   npm run record:report [-- --json]    recording-quality report (read-only)
 *
 * Stop recording with Ctrl+C (clean stop is recorded in recorder_runs).
 */
import 'dotenv/config';
import { existsSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { ConfigError } from '../config/env';
import { DexScreenerProvider } from '../market/dexscreenerProvider';
import { loadRecorderConfig } from './config';
import { RecorderGuardError, openRecorderDb } from './db';
import { startKeepAwake, stopKeepAwake } from './keepAwake';
import { MarketRecorder } from './recorder';
import { buildQualityReport, formatQualityReport } from './report';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    'keep-awake': { type: 'boolean', default: false },
  },
});

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';

let cfg;
try {
  cfg = loadRecorderConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[recorder] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (positionals[0] === 'report') {
  if (!existsSync(cfg.dbPath)) {
    console.error(`[recorder] No recordings database at ${cfg.dbPath} yet.`);
    process.exit(1);
  }
  const db = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  const report = buildQualityReport(db);
  db.close();
  console.log(values.json ? JSON.stringify(report, null, 2) : formatQualityReport(report));
  process.exit(0);
}

let db: Database.Database;
try {
  db = openRecorderDb(cfg.dbPath, cfg.tradingDbPath);
} catch (err) {
  if (err instanceof RecorderGuardError) {
    console.error(`[recorder] ${err.message}`);
    process.exit(2);
  }
  throw err;
}

const provider = new DexScreenerProvider({ ...cfg.dexscreener, maxTracked: cfg.maxTracked, clock: Date.now });
const recorder = new MarketRecorder({
  db,
  provider,
  clock: Date.now,
  intervalMs: cfg.intervalMs,
  retentionDays: cfg.retentionDays,
  runConfig: {
    provider: 'dexscreener',
    dexIds: cfg.dexscreener.dexIds,
    watchlist: cfg.dexscreener.watchlist,
    searchQueries: cfg.dexscreener.searchQueries,
    maxTracked: cfg.maxTracked,
    discoveryIntervalMs: cfg.dexscreener.discoveryIntervalMs,
  },
  log: (m) => console.log(`${stamp()} [recorder] ${m}`),
});

const keepAwake = values['keep-awake'] ? startKeepAwake() : null;
console.log(`${stamp()} [recorder] READ-ONLY market-data recorder started (run ${recorder.runId}).`);
console.log(`${stamp()} [recorder] database: ${cfg.dbPath} (separate from trading DB ${cfg.tradingDbPath ?? 'n/a'})`);
console.log(`${stamp()} [recorder] interval ${cfg.intervalMs / 1000} s, max tracked ${cfg.maxTracked}, retention ${cfg.retentionDays} d, keep-awake ${keepAwake ? 'on' : 'off'}. Ctrl+C to stop.`);

// Periodic one-line status (polls are logged only when something notable happens).
let polls = 0;
const statusTimer = setInterval(() => {
  const r = db.prepare("SELECT COUNT(*) AS n, SUM(status = 'failed') AS f FROM polls WHERE run_id = ?").get(recorder.runId) as { n: number; f: number | null };
  const o = db.prepare('SELECT COUNT(*) AS n FROM observations WHERE run_id = ?').get(recorder.runId) as { n: number };
  const sizeMb = statSync(cfg.dbPath).size / 1_048_576;
  polls = r.n;
  console.log(`${stamp()} [recorder] run ${recorder.runId}: ${polls} polls (${r.f ?? 0} failed), ${o.n} observations, tracked ${provider.trackedCount()}, db ${sizeMb.toFixed(1)} MB`);
  if (sizeMb > cfg.maxDbMb) console.warn(`${stamp()} [recorder] WARNING: database exceeds RECORDER_MAX_DB_MB (${cfg.maxDbMb} MB); lower retention or archive the file.`);
}, 60_000);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(statusTimer);
  console.log(`${stamp()} [recorder] ${signal} received, stopping cleanly...`);
  await recorder.stop(signal);
  stopKeepAwake(keepAwake);
  db.close();
  console.log(`${stamp()} [recorder] stopped. Run ${recorder.runId} marked clean.`);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

recorder.start();
