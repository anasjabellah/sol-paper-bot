/**
 * On-chain event recorder CLI (opt-in; separate process; never starts the API or the bot).
 *
 *   npm run onchain                                  same as 'check' (the default; never records or migrates)
 *   npm run onchain -- check                         validate config and pinned IDLs (no network, no DB access)
 *   npm run onchain:report [-- --json]               read-only report of the on-chain tables
 *   npm run onchain -- record --live --max-minutes 5 record from the real services (requires HELIUS_API_KEY, v2 DB)
 *   npm run onchain -- record --live --migrate       first run only: apply the additive v2 tables, then record
 *
 * Recording happens only with the explicit 'record' command; migration only with 'record --migrate'.
 * Remote endpoints (Helius, DexScreener) additionally require --live, and are always refused under a
 * test runner (VITEST / NODE_ENV=test / ONCHAIN_FORBID_NETWORK=true). Without --live only loopback
 * endpoints (a local test server) are allowed. 'record' exits 3 when HELIUS_API_KEY is empty.
 * Stop with Ctrl+C.
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { ConfigError } from '../config/env';
import { DexScreenerProvider } from '../market/dexscreenerProvider';
import { RecorderGuardError, assertNotTradingDb } from '../recorder/db';
import { UsageBudget } from './budget';
import { assertNetworkAllowed, describeConfig, loadOnchainConfig, networkEndpoints } from './config';
import { openOnchainDb, readSchemaVersion } from './db';
import { DexScreenerDiscovery, applyWatchChange, discoverOnce } from './discovery';
import { HeliusRpc, redact, withApiKey } from './helius';
import { DECODER_VERSION, IdlIntegrityError, loadPinnedDecoder } from './idl';
import { OnchainRecorder, type WsFactory, type WsLike } from './recorder';
import { buildOnchainReport, formatOnchainReport } from './report';
import { WatchlistManager, type WatchChange } from './watchlist';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    migrate: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    'max-minutes': { type: 'string' },
  },
});

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
let apiKey = '';
const say = (msg: string) => console.log(`${stamp()} [onchain] ${redact(msg, apiKey)}`);
const fail = (msg: string, code: number): never => {
  console.error(`[onchain] ${redact(msg, apiKey)}`);
  process.exit(code);
};

let cfg;
try {
  cfg = loadOnchainConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) fail(err.message, 1);
  throw err;
}
apiKey = cfg.apiKey;

let decoder;
try {
  decoder = loadPinnedDecoder();
} catch (err) {
  if (err instanceof IdlIntegrityError) fail(`IDL integrity check failed: ${err.message}`, 1);
  throw err;
}

const command = positionals[0] ?? 'check';
for (const flag of ['migrate', 'live', 'max-minutes'] as const) {
  const set = flag === 'max-minutes' ? values[flag] !== undefined : values[flag];
  if (set && command !== 'record') fail(`--${flag} is only accepted together with the record command`, 1);
}

if (command === 'check') {
  console.log(
    JSON.stringify(
      {
        decoderVersion: DECODER_VERSION,
        events: decoder.eventSpecs().filter((e) => e.targeted),
        endpoints: networkEndpoints(cfg).map((e) => ({ name: e.name, host: new URL(e.url).host })),
        config: describeConfig(cfg),
      },
      null,
      2,
    ),
  );
  console.log(cfg.enabled ? 'HELIUS_API_KEY is set (value not shown).' : 'HELIUS_API_KEY is empty: the on-chain recorder is DISABLED.');
  console.log("Nothing was started and no database was opened. Recording requires 'record' (and --live for remote endpoints).");
  process.exit(0);
}

if (command === 'report') {
  if (!existsSync(cfg.dbPath)) fail(`No recordings database at ${cfg.dbPath} yet.`, 1);
  const db = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  const report = buildOnchainReport(db, Date.now(), cfg.limits);
  db.close();
  console.log(values.json ? JSON.stringify(report, null, 2) : formatOnchainReport(report));
  process.exit(0);
}

if (command !== 'record') fail(`Unknown command '${command}' (use: check, report, record)`, 1);

if (!cfg.enabled) fail('HELIUS_API_KEY is empty: the on-chain recorder is disabled. Nothing was started.', 3);
// Network gate first: nothing is opened or contacted unless every endpoint is allowed.
try {
  assertNetworkAllowed(cfg, { live: values.live, env: process.env });
} catch (err) {
  if (err instanceof ConfigError) fail(err.message, 6);
  throw err;
}
if (!cfg.watchlist.length && cfg.discovery === 'off') fail('Nothing to watch: set ONCHAIN_WATCHLIST and/or ONCHAIN_DISCOVERY=dexscreener.', 1);
const maxMinutes = values['max-minutes'] === undefined ? null : Number(values['max-minutes']);
if (maxMinutes !== null && !(maxMinutes > 0 && maxMinutes <= 7 * 24 * 60)) fail('--max-minutes must be a positive number of minutes', 1);

// Refuse before touching anything if the target is the trading DB; require --migrate for v1 -> v2.
try {
  assertNotTradingDb(cfg.dbPath, cfg.tradingDbPath);
} catch (err) {
  if (err instanceof RecorderGuardError) fail(err.message, 2);
  throw err;
}
if (!existsSync(cfg.dbPath) && !values.migrate) {
  fail(`No recordings database at ${cfg.dbPath}. Refusing to create one without --migrate (check RECORDER_DATABASE_URL).`, 4);
}
if (existsSync(cfg.dbPath)) {
  const probe = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  const hasMeta = probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recorder_meta'").get();
  const version = hasMeta ? readSchemaVersion(probe) : null;
  probe.close();
  if (version !== 2 && !values.migrate) {
    fail(
      `${cfg.dbPath} is at schema_version ${version ?? 'none'}. The on-chain recorder adds new tables (additive, existing tables and rows untouched). ` +
        'Re-run with --migrate to apply them. Back up the file first if you want a copy.',
      4,
    );
  }
}

let db: Database.Database;
try {
  db = openOnchainDb(cfg.dbPath, cfg.tradingDbPath, Date.now());
} catch (err) {
  if (err instanceof RecorderGuardError) fail(err.message, 2);
  throw err;
}

const budget = new UsageBudget(db, cfg.limits, cfg.model, Date.now);
const startState = budget.check();
if (!startState.ok) {
  db.close();
  fail(`Not starting: ${startState.reason}.`, 5);
}

const wsFactory: WsFactory = (url) => {
  const WS = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
  if (!WS) throw new Error('This Node.js version has no global WebSocket (Node 22+ required)');
  return new WS(url);
};

const watchlist = new WatchlistManager({
  db,
  clock: Date.now,
  maxActive: cfg.maxActive,
  idleEvictMs: cfg.idleEvictMs,
  minWatchMs: cfg.minWatchMs,
  staticMints: cfg.watchlist,
});
const initial = watchlist.init();

const recorder = new OnchainRecorder({
  db,
  decoder,
  budget,
  rpc: new HeliusRpc({ url: withApiKey(cfg.rpcUrl, cfg.apiKey), apiKey: cfg.apiKey, budget, minIntervalMs: cfg.rpcMinIntervalMs }),
  wsFactory,
  wsUrl: withApiKey(cfg.wsUrl, cfg.apiKey),
  apiKey: cfg.apiKey,
  subscriptions: initial,
  clock: Date.now,
  log: say,
  backfillMaxSignatures: cfg.backfillMaxSignatures,
  backfillOnStart: cfg.backfillOnStart,
  storeRaw: cfg.storeRaw,
  maxTxVersion: cfg.maxTxVersion,
  keepalive: cfg.keepalive,
  resolvePools: cfg.resolvePools,
  hooks: {
    onSubscribed: (mint, at) => watchlist.noteSubscribed(mint, at),
    onEvent: (e) => watchlist.noteEvent(e),
    onPoolResolved: (row) => row.base_mint && watchlist.notePoolResolved(row.pool, row.base_mint, row.method ?? 'unknown'),
  },
  runConfig: describeConfig(cfg),
});

const applyChange = (c: WatchChange) => {
  applyWatchChange(recorder, c);
  if (c.added.length || c.removed.length) say(`watchlist: +${c.added.length} -${c.removed.length} (active ${recorder.subscriptions().length}/${cfg.maxActive})`);
};

say(`recording ${initial.length} subscription(s) to ${cfg.dbPath} (decoder ${DECODER_VERSION}); discovery: ${cfg.discovery}`);
say(`budget: ${cfg.limits.dailyCredits} credits/day, ${cfg.limits.monthlyCredits} credits/month, ${Math.round(cfg.limits.dailyBytes / 1_048_576)} MB/day`);
recorder.start();

let discoveryTimer: NodeJS.Timeout | null = null;
if (cfg.discovery === 'dexscreener') {
  const discovery = new DexScreenerDiscovery(new DexScreenerProvider({ ...cfg.dexscreener, maxTracked: cfg.maxActive * 3, clock: Date.now }));
  const runDiscovery = async () => {
    const res = await discoverOnce(discovery, watchlist, recorder);
    if (res.error) say(`discovery failed (no new candidates; idle eviction still applied): ${res.error}`);
    if (res.added.length || res.removed.length || res.hinted) say(`watchlist: +${res.added.length} -${res.removed.length}, pool hints ${res.hinted} (active ${recorder.subscriptions().length}/${cfg.maxActive})`);
  };
  void runDiscovery();
  discoveryTimer = setInterval(() => void runDiscovery(), cfg.discoveryIntervalMs);
} else {
  discoveryTimer = setInterval(() => applyChange(watchlist.rebalance()), 300_000);
}

const statsTimer = setInterval(() => {
  if (recorder.status === 'stopped') return void shutdown('recorder_stopped');
  const u = budget.today();
  const s = recorder.stats;
  say(
    `${recorder.status}: watching ${recorder.subscriptions().length}, notifications ${s.notifications}, events +${s.eventsInserted} (dup ${s.eventsDuplicate}), ` +
      `quarantined ${s.quarantined}, decode errors ${s.decodeErrors}, tx fetched ${s.transactionsFetched}, keepalives ${s.keepalivesSent}, credits today ${u.credits}`,
  );
}, 60_000);

let shuttingDown = false;
const shutdown = async (reason: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(statsTimer);
  if (discoveryTimer) clearInterval(discoveryTimer);
  await recorder.stop(reason);
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('sigint'));
process.on('SIGTERM', () => void shutdown('sigterm'));
if (maxMinutes !== null) setTimeout(() => void shutdown(`max_minutes_${maxMinutes}`), maxMinutes * 60_000);
