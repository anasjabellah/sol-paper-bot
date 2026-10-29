/** Read-only summary of the on-chain tables in recordings.db. */
import type Database from 'better-sqlite3';
import { utcDay, type BudgetLimits } from './budget';
import { ONCHAIN_TABLES } from './db';

export interface OnchainReport {
  schemaVersion: number | null;
  migrated: boolean;
  sessions: { id: string; started_at: number; stopped_at: number | null; stop_reason: string | null; decoder_version: string }[];
  events: { event_type: string; decode_status: string; n: number }[];
  pumpSwapTradesWithoutMint: number;
  quoteAssets: { quote_asset: string | null; n: number }[];
  quarantine: { event_type: string | null; decode_status: string; n: number }[];
  watchlist: { status: string; lifecycle: string; n: number }[];
  pools: { status: string; method: string | null; n: number }[];
  unresolvedPumpSwapEvents: number;
  /** Subscription periods by how they ended; covered_ms uses the conservative onchain_coverage view. */
  coverage: { end_kind: string; periods: number; mints: number; covered_ms: number | null }[];
  errors: { kind: string; n: number }[];
  gaps: { kind: string; status: string; n: number }[];
  rawMessages: { n: number; bytes: number; incomplete: number };
  usageToday: { day: string; credits: number; ws_bytes: number; rpc_bytes: number; rpc_calls: number; ws_connections: number } | null;
  usageMonthCredits: number;
  limits: BudgetLimits | null;
}

export function buildOnchainReport(db: Database.Database, now: number, limits: BudgetLimits | null = null): OnchainReport {
  const meta = db.prepare("SELECT value FROM recorder_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
  const migrated = ONCHAIN_TABLES.every((t) => tables.has(t));
  const base: OnchainReport = {
    schemaVersion: meta ? Number(meta.value) : null,
    migrated,
    sessions: [],
    events: [],
    pumpSwapTradesWithoutMint: 0,
    quoteAssets: [],
    quarantine: [],
    watchlist: [],
    pools: [],
    unresolvedPumpSwapEvents: 0,
    coverage: [],
    errors: [],
    gaps: [],
    rawMessages: { n: 0, bytes: 0, incomplete: 0 },
    usageToday: null,
    usageMonthCredits: 0,
    limits,
  };
  if (!migrated) return base;
  const day = utcDay(now);
  return {
    ...base,
    sessions: db.prepare('SELECT id, started_at, stopped_at, stop_reason, decoder_version FROM onchain_sessions ORDER BY started_at DESC LIMIT 5').all() as OnchainReport['sessions'],
    events: db.prepare('SELECT event_type, decode_status, COUNT(*) AS n FROM chain_events GROUP BY 1, 2 ORDER BY 1, 2').all() as OnchainReport['events'],
    pumpSwapTradesWithoutMint: (db.prepare("SELECT COUNT(*) AS n FROM chain_events WHERE event_type IN ('BuyEvent', 'SellEvent') AND mint IS NULL").get() as { n: number }).n,
    quoteAssets: db.prepare('SELECT quote_asset, COUNT(*) AS n FROM chain_events GROUP BY 1 ORDER BY 1').all() as OnchainReport['quoteAssets'],
    quarantine: db.prepare('SELECT event_type, decode_status, COUNT(*) AS n FROM onchain_quarantine GROUP BY 1, 2 ORDER BY 1, 2').all() as OnchainReport['quarantine'],
    watchlist: db.prepare('SELECT status, lifecycle, COUNT(*) AS n FROM onchain_watchlist GROUP BY 1, 2 ORDER BY 1, 2').all() as OnchainReport['watchlist'],
    coverage: db
      .prepare(
        "SELECT end_kind, COUNT(*) AS periods, COUNT(DISTINCT mint) AS mints, SUM(CASE WHEN end_kind = 'active' THEN NULL ELSE covered_until - started_at END) AS covered_ms FROM onchain_coverage GROUP BY 1 ORDER BY 1",
      )
      .all() as OnchainReport['coverage'],
    pools: db.prepare('SELECT status, method, COUNT(*) AS n FROM onchain_pools GROUP BY 1, 2 ORDER BY 1, 2').all() as OnchainReport['pools'],
    unresolvedPumpSwapEvents: (db.prepare("SELECT COUNT(*) AS n FROM chain_events_resolved WHERE event_type IN ('BuyEvent', 'SellEvent') AND resolved_mint IS NULL").get() as { n: number }).n,
    errors: db.prepare('SELECT kind, COUNT(*) AS n FROM onchain_errors GROUP BY 1 ORDER BY 1').all() as OnchainReport['errors'],
    gaps: db.prepare('SELECT kind, status, COUNT(*) AS n FROM onchain_gaps GROUP BY 1, 2 ORDER BY 1, 2').all() as OnchainReport['gaps'],
    rawMessages: db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(complete = 0), 0) AS incomplete FROM onchain_raw_messages')
      .get() as OnchainReport['rawMessages'],
    usageToday: (db.prepare('SELECT day, credits, ws_bytes, rpc_bytes, rpc_calls, ws_connections FROM onchain_usage WHERE day = ?').get(day) as OnchainReport['usageToday']) ?? null,
    usageMonthCredits: (db.prepare('SELECT COALESCE(SUM(credits), 0) AS c FROM onchain_usage WHERE substr(day, 1, 7) = ?').get(day.slice(0, 7)) as { c: number }).c,
  };
}

const iso = (ms: number | null) => (ms === null ? '-' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z');

export function formatOnchainReport(r: OnchainReport): string {
  const lines = [`On-chain recorder report (recordings schema_version ${r.schemaVersion ?? '?'})`];
  if (!r.migrated) {
    lines.push('On-chain tables are not present: the v2 migration has not been applied (run the recorder once with --migrate).');
    return lines.join('\n');
  }
  lines.push('', 'Sessions (latest 5):');
  if (!r.sessions.length) lines.push('  none');
  for (const s of r.sessions) lines.push(`  ${iso(s.started_at)} -> ${iso(s.stopped_at)}  ${s.stop_reason ?? (s.stopped_at ? '' : 'NOT CLEANLY STOPPED')}  [${s.decoder_version}]`);
  lines.push('', 'Events (type / decode status / count):');
  if (!r.events.length) lines.push('  none');
  for (const e of r.events) lines.push(`  ${e.event_type.padEnd(32)} ${e.decode_status.padEnd(12)} ${e.n}`);
  lines.push(`  PumpSwap trades without a mint in the row: ${r.pumpSwapTradesWithoutMint}; still unresolved after pool resolution: ${r.unresolvedPumpSwapEvents}`);
  lines.push(`  Quote asset: ${r.quoteAssets.map((q) => `${q.quote_asset ?? 'unknown'} ${q.n}`).join(', ') || 'none'}`);
  lines.push('', 'Quarantined (layout does not match the pinned IDL exactly):');
  if (!r.quarantine.length) lines.push('  none');
  for (const q of r.quarantine) lines.push(`  ${(q.event_type ?? '?').padEnd(32)} ${q.decode_status.padEnd(12)} ${q.n}`);
  lines.push('', 'Watchlist (status / lifecycle / count):');
  if (!r.watchlist.length) lines.push('  none');
  for (const w of r.watchlist) lines.push(`  ${w.status.padEnd(10)} ${w.lifecycle.padEnd(14)} ${w.n}`);
  lines.push('', 'Subscription coverage (end kind / periods / mints / covered hours):');
  if (!r.coverage.length) lines.push('  none');
  for (const c of r.coverage) lines.push(`  ${c.end_kind.padEnd(12)} ${String(c.periods).padEnd(8)} ${String(c.mints).padEnd(6)} ${c.covered_ms === null ? '(open)' : (c.covered_ms / 3_600_000).toFixed(2)}`);
  lines.push('  Coverage exists only inside subscription periods; lost/end_unknown periods count only up to the last message received.');
  lines.push('', 'PumpSwap pools (status / method / count):');
  if (!r.pools.length) lines.push('  none');
  for (const p of r.pools) lines.push(`  ${p.status.padEnd(14)} ${(p.method ?? '-').padEnd(22)} ${p.n}`);
  lines.push('', 'Errors by kind:');
  if (!r.errors.length) lines.push('  none');
  for (const e of r.errors) lines.push(`  ${e.kind.padEnd(24)} ${e.n}`);
  lines.push('', 'Gaps (kind / status / count):');
  if (!r.gaps.length) lines.push('  none');
  for (const g of r.gaps) lines.push(`  ${g.kind.padEnd(18)} ${g.status.padEnd(22)} ${g.n}`);
  lines.push('', `Raw messages: ${r.rawMessages.n} (${(r.rawMessages.bytes / 1_048_576).toFixed(2)} MB), incomplete: ${r.rawMessages.incomplete}`);
  const u = r.usageToday;
  const lim = r.limits;
  lines.push('', 'Estimated usage (credit model estimate; the Helius dashboard is authoritative):');
  lines.push(`  today ${u?.day ?? '-'}: credits ${u?.credits ?? 0}${lim ? ` / ${lim.dailyCredits}` : ''}, bytes ${((u?.ws_bytes ?? 0) + (u?.rpc_bytes ?? 0)).toLocaleString('en-US')}${lim ? ` / ${lim.dailyBytes.toLocaleString('en-US')}` : ''}, RPC calls ${u?.rpc_calls ?? 0}, WS connections ${u?.ws_connections ?? 0}`);
  lines.push(`  this month: credits ${r.usageMonthCredits}${lim ? ` / ${lim.monthlyCredits}` : ''}`);
  return lines.join('\n');
}
