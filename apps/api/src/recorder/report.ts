import type Database from 'better-sqlite3';

/**
 * Recording-quality report. Read-only: works on a database opened with { readonly: true }.
 * Everything is computed from what was actually recorded; nothing is interpolated or filled in.
 */

const MISSING_FIELDS = [
  'price_sol',
  'price_usd',
  'quote_reserve_sol',
  'base_reserve',
  'liquidity_usd',
  'volume_5m_sol',
  'buys_5m',
  'sells_5m',
  'price_change_5m_pct',
  'pair_created_at',
] as const;

export interface QualityReport {
  generatedAt: number;
  intervalMs: number | null;
  runs: { id: string; startedAt: number; stoppedAt: number | null; stopReason: string | null; cleanStop: boolean }[];
  polls: {
    total: number;
    ok: number;
    cached: number;
    failed: number;
    rateLimited: number;
    firstAt: number | null;
    lastAt: number | null;
    intervalMs: { median: number | null; p95: number | null; max: number | null };
    /** Successful polls / polls expected at the configured interval over each run's polling span. */
    coveragePct: number | null;
  };
  gaps: { count: number; totalMs: number; longest: { fromTs: number; toTs: number; kind: string; ms: number }[] };
  observations: {
    total: number;
    tokens: number;
    firstAt: number | null;
    lastAt: number | null;
    perToken: { median: number | null; max: number | null };
    /** Tokens with at least one contiguous series (consecutive fetches <= 2x interval apart) of >= 1 hour. */
    tokensWithContiguousHour: number;
    longestContiguousMinutes: number;
  };
  duplicates: { ignored: number; outOfOrderRejected: number };
  rejections: { total: number; byReason: Record<string, number> };
  missingValuesPct: Record<string, number | null>;
  quotePoolGap: { withReservesPct: number | null; p25: number | null; median: number | null; p75: number | null; p90: number | null; within2Pct: number | null; within15Pct: number | null };
  unchangedConsecutivePct: number | null;
  impliedSolUsd: { min: number | null; median: number | null; max: number | null };
  notes: string[];
}

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

export function buildQualityReport(db: Database.Database, now = Date.now()): QualityReport {
  const runs = (db.prepare('SELECT id, started_at, stopped_at, stop_reason, config_json FROM recorder_runs ORDER BY started_at').all() as {
    id: string;
    started_at: number;
    stopped_at: number | null;
    stop_reason: string | null;
    config_json: string;
  }[]);
  const intervalMs = runs.length ? ((JSON.parse(runs[runs.length - 1].config_json) as { intervalMs?: number }).intervalMs ?? null) : null;

  // ---- polls & cadence
  const pollStats = db.prepare(`SELECT COUNT(*) AS total,
      SUM(status = 'ok') AS ok, SUM(status = 'cached') AS cached, SUM(status = 'failed') AS failed,
      SUM(rate_limited_until IS NOT NULL) AS rl, MIN(poll_started_at) AS first, MAX(poll_started_at) AS last,
      COALESCE(SUM(duplicates), 0) AS dups FROM polls`).get() as Record<string, number | null>;
  const intervals: number[] = [];
  let expected = 0;
  let okCount = 0;
  for (const run of runs) {
    const ts = (db.prepare("SELECT poll_started_at AS t FROM polls WHERE run_id = ? AND status IN ('ok','cached') ORDER BY poll_started_at").all(run.id) as { t: number }[]).map((r) => r.t);
    okCount += ts.length;
    for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
    const allTs = db.prepare('SELECT MIN(poll_started_at) AS a, MAX(poll_started_at) AS b FROM polls WHERE run_id = ?').get(run.id) as { a: number | null; b: number | null };
    if (intervalMs && allTs.a !== null && allTs.b !== null) expected += Math.floor((allTs.b - allTs.a) / intervalMs) + 1;
  }
  intervals.sort((a, b) => a - b);

  // ---- gaps
  const gapRows = (db.prepare('SELECT from_ts, to_ts, kind FROM gaps ORDER BY (to_ts - from_ts) DESC').all() as { from_ts: number; to_ts: number; kind: string }[]);

  // ---- observations: per-token series, quality metrics
  const obsStats = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT mint) AS tokens, MIN(fetched_at) AS a, MAX(fetched_at) AS b FROM observations').get() as {
    n: number;
    tokens: number;
    a: number | null;
    b: number | null;
  };
  const perToken = (db.prepare('SELECT COUNT(*) AS n FROM observations GROUP BY mint').all() as { n: number }[]).map((r) => r.n).sort((a, b) => a - b);
  const contiguityLimit = (intervalMs ?? 15_000) * 2;
  let longestContiguous = 0;
  let tokensWithHour = 0;
  let consecutivePairs = 0;
  let unchangedPairs = 0;
  const gapsPct: number[] = [];
  const solUsd: number[] = [];
  let withReserves = 0;
  let prev: { mint: string; t: number; key: string; runStart: number; hour: boolean } | null = null;
  const missing: Record<string, number> = Object.fromEntries(MISSING_FIELDS.map((f) => [f, 0]));
  const iter = db
    .prepare(`SELECT mint, fetched_at, ${MISSING_FIELDS.join(', ')} FROM observations ORDER BY mint, fetched_at`)
    .iterate() as IterableIterator<Record<string, number | string | null>>;
  const flushToken = (p: typeof prev) => {
    if (p?.hour) tokensWithHour++;
  };
  for (const row of iter) {
    const mint = row.mint as string;
    const t = row.fetched_at as number;
    for (const f of MISSING_FIELDS) if (row[f] === null) missing[f]++;
    const price = row.price_sol as number | null;
    const q = row.quote_reserve_sol as number | null;
    const b = row.base_reserve as number | null;
    if (price !== null && q !== null && b !== null && q > 0 && b > 0) {
      withReserves++;
      gapsPct.push(Math.abs(price / (q / b) - 1) * 100);
    }
    const usd = row.price_usd as number | null;
    if (price && usd) solUsd.push(usd / price);
    const key = JSON.stringify([price, q, b, row.volume_5m_sol, row.buys_5m, row.sells_5m, row.price_change_5m_pct]);
    if (prev && prev.mint === mint) {
      consecutivePairs++;
      if (prev.key === key) unchangedPairs++;
      const runStart: number = t - prev.t <= contiguityLimit ? prev.runStart : t;
      const spanMin = (t - runStart) / 60_000;
      longestContiguous = Math.max(longestContiguous, spanMin);
      prev = { mint, t, key, runStart, hour: prev.hour || spanMin >= 60 };
    } else {
      flushToken(prev);
      prev = { mint, t, key, runStart: t, hour: false };
    }
  }
  flushToken(prev);
  gapsPct.sort((a, b) => a - b);
  solUsd.sort((a, b) => a - b);

  const rejRows = db.prepare('SELECT reason FROM rejections').all() as { reason: string }[];
  const byReason: Record<string, number> = {};
  for (const r of rejRows) {
    const k = r.reason.split(':')[0];
    byReason[k] = (byReason[k] ?? 0) + 1;
  }

  const notes: string[] = [];
  const unclean = runs.filter((r) => r.stopped_at === null);
  if (unclean.length) notes.push(`${unclean.length} run(s) have no clean stop (still running, crashed or force-killed).`);
  if (gapRows.length) notes.push('Series are NOT contiguous across recorded gaps; split backtests at gap boundaries.');
  notes.push('fetched_at is when this app received the data; DexScreener provides no per-record source timestamp (source_ts is NULL).');
  notes.push('These are real, read-only DexScreener observations. No values are interpolated or synthesised.');

  return {
    generatedAt: now,
    intervalMs,
    runs: runs.map((r) => ({ id: r.id, startedAt: r.started_at, stoppedAt: r.stopped_at, stopReason: r.stop_reason, cleanStop: r.stopped_at !== null })),
    polls: {
      total: Number(pollStats.total ?? 0),
      ok: Number(pollStats.ok ?? 0),
      cached: Number(pollStats.cached ?? 0),
      failed: Number(pollStats.failed ?? 0),
      rateLimited: Number(pollStats.rl ?? 0),
      firstAt: pollStats.first as number | null,
      lastAt: pollStats.last as number | null,
      intervalMs: { median: quantile(intervals, 0.5), p95: quantile(intervals, 0.95), max: intervals.length ? intervals[intervals.length - 1] : null },
      coveragePct: expected > 0 ? Math.min(100, (okCount / expected) * 100) : null,
    },
    gaps: {
      count: gapRows.length,
      totalMs: gapRows.reduce((s, g) => s + (g.to_ts - g.from_ts), 0),
      longest: gapRows.slice(0, 5).map((g) => ({ fromTs: g.from_ts, toTs: g.to_ts, kind: g.kind, ms: g.to_ts - g.from_ts })),
    },
    observations: {
      total: obsStats.n,
      tokens: obsStats.tokens,
      firstAt: obsStats.a,
      lastAt: obsStats.b,
      perToken: { median: quantile(perToken, 0.5), max: perToken.length ? perToken[perToken.length - 1] : null },
      tokensWithContiguousHour: tokensWithHour,
      longestContiguousMinutes: Math.round(longestContiguous * 10) / 10,
    },
    duplicates: { ignored: Number(pollStats.dups ?? 0), outOfOrderRejected: byReason['out-of-order'] ?? 0 },
    rejections: { total: rejRows.length, byReason },
    missingValuesPct: Object.fromEntries(MISSING_FIELDS.map((f) => [f, pct(missing[f], obsStats.n)])),
    quotePoolGap: {
      withReservesPct: pct(withReserves, obsStats.n),
      p25: quantile(gapsPct, 0.25),
      median: quantile(gapsPct, 0.5),
      p75: quantile(gapsPct, 0.75),
      p90: quantile(gapsPct, 0.9),
      within2Pct: pct(gapsPct.filter((g) => g <= 2).length, gapsPct.length),
      within15Pct: pct(gapsPct.filter((g) => g <= 15).length, gapsPct.length),
    },
    unchangedConsecutivePct: pct(unchangedPairs, consecutivePairs),
    impliedSolUsd: { min: solUsd[0] ?? null, median: quantile(solUsd, 0.5), max: solUsd.length ? solUsd[solUsd.length - 1] : null },
    notes,
  };
}

const f = (n: number | null, d = 2) => (n === null ? 'n/a' : n.toFixed(d));
const ts = (n: number | null) => (n === null ? 'n/a' : new Date(n).toISOString().replace('T', ' ').slice(0, 19) + 'Z');

export function formatQualityReport(r: QualityReport): string {
  const lines = [
    '=== Recording quality report (real DexScreener observations, read-only) ===',
    `generated ${ts(r.generatedAt)}; configured interval ${r.intervalMs ? r.intervalMs / 1000 + ' s' : 'n/a'}`,
    `runs: ${r.runs.length} (${r.runs.filter((x) => !x.cleanStop).length} without clean stop)`,
    `polls: ${r.polls.total} total, ${r.polls.ok} ok, ${r.polls.cached} cached, ${r.polls.failed} failed, ${r.polls.rateLimited} while rate-limited; ${ts(r.polls.firstAt)} -> ${ts(r.polls.lastAt)}`,
    `poll spacing: median ${f(r.polls.intervalMs.median ? r.polls.intervalMs.median / 1000 : null, 1)} s, p95 ${f(r.polls.intervalMs.p95 ? r.polls.intervalMs.p95 / 1000 : null, 1)} s, max ${f(r.polls.intervalMs.max ? r.polls.intervalMs.max / 1000 : null, 1)} s; coverage ${f(r.polls.coveragePct, 1)}%`,
    `gaps: ${r.gaps.count}, total ${f(r.gaps.totalMs / 60_000, 1)} min${r.gaps.longest.length ? '; longest: ' + r.gaps.longest.map((g) => `${g.kind} ${ts(g.fromTs)} +${f(g.ms / 60_000, 1)} min`).join(', ') : ''}`,
    `observations: ${r.observations.total} for ${r.observations.tokens} tokens (${ts(r.observations.firstAt)} -> ${ts(r.observations.lastAt)}); per token median ${f(r.observations.perToken.median, 0)}, max ${f(r.observations.perToken.max, 0)}`,
    `contiguous series: longest ${f(r.observations.longestContiguousMinutes, 1)} min; tokens with >= 1 h contiguous: ${r.observations.tokensWithContiguousHour}`,
    `duplicates ignored: ${r.duplicates.ignored}; out-of-order rejected: ${r.duplicates.outOfOrderRejected}; rejections: ${r.rejections.total} ${JSON.stringify(r.rejections.byReason)}`,
    `missing values (%): ${Object.entries(r.missingValuesPct).map(([k, v]) => `${k} ${f(v, 1)}`).join(', ')}`,
    `quote vs pool-implied price |gap|: with reserves ${f(r.quotePoolGap.withReservesPct, 1)}%; p25 ${f(r.quotePoolGap.p25, 1)}% median ${f(r.quotePoolGap.median, 1)}% p75 ${f(r.quotePoolGap.p75, 1)}% p90 ${f(r.quotePoolGap.p90, 1)}%; within 2%: ${f(r.quotePoolGap.within2Pct, 1)}%, within 15% (modelable): ${f(r.quotePoolGap.within15Pct, 1)}%`,
    `unchanged market fields between consecutive snapshots: ${f(r.unchangedConsecutivePct, 1)}%`,
    `implied SOL/USD across observations: min ${f(r.impliedSolUsd.min)} median ${f(r.impliedSolUsd.median)} max ${f(r.impliedSolUsd.max)}`,
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.join('\n');
}
