import type Database from 'better-sqlite3';
import { MarketObservationSchema, type MarketObservation } from '@spb/shared';
import type { MarketDataProvider } from '../market/provider';
import { ProviderError } from '../market/provider';
import { errorMessage, newId, type Clock } from '../lib/util';

/** Observations stamped further than this into the future are rejected (clock-skew tolerance). */
const MAX_FUTURE_SKEW_MS = 5_000;
const MAX_BACKOFF_MS = 120_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;

export interface RecorderDeps {
  db: Database.Database;
  provider: MarketDataProvider;
  clock: Clock;
  intervalMs: number;
  retentionDays: number;
  /** Stored with the run for reproducibility (no secrets). */
  runConfig: Record<string, unknown>;
  version?: string;
  log?: (msg: string) => void;
}

export interface PollOutcome {
  pollId: string;
  status: 'ok' | 'cached' | 'failed';
  observations: number;
  duplicates: number;
  rejected: number;
  skipped: number;
  error: string | null;
  /** Delay the scheduler waits before the next poll. */
  nextDelayMs: number;
}

/**
 * READ-ONLY market-data recorder. Polls a provider on a fixed cadence and appends validated
 * observations to its own SQLite database. Never touches the trading database, places orders
 * or signs anything. Only real (non-simulated) DexScreener observations are stored.
 */
export class MarketRecorder {
  readonly runId: string;
  readonly gapThresholdMs: number;
  private lastResult: unknown = undefined;
  private lastSuccessAt: number | null = null;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inFlight: Promise<PollOutcome> | null = null;
  private readonly abort = new AbortController();
  private lastPruneAt = 0;
  private stopped = false;

  constructor(private readonly d: RecorderDeps) {
    const now = d.clock();
    this.runId = newId(now);
    this.gapThresholdMs = Math.max(60_000, 3 * d.intervalMs);
    const prevOk = d.db.prepare("SELECT MAX(poll_started_at) AS t FROM polls WHERE status IN ('ok', 'cached')").get() as { t: number | null };
    d.db
      .prepare('INSERT INTO recorder_runs (id, started_at, version, config_json) VALUES (?, ?, ?, ?)')
      .run(this.runId, now, d.version ?? '0.1.0', JSON.stringify({ intervalMs: d.intervalMs, retentionDays: d.retentionDays, ...d.runConfig }));
    // Time between the previous run's last successful poll and this start was not recorded.
    if (prevOk.t !== null && now - prevOk.t > this.gapThresholdMs) {
      d.db.prepare("INSERT INTO gaps (run_id, from_ts, to_ts, kind) VALUES (?, ?, ?, 'between_runs')").run(this.runId, prevOk.t, now);
    }
  }

  /** Starts the polling loop (first poll immediately). */
  start(): void {
    this.schedule(0);
  }

  private schedule(delayMs: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.pollOnce().then((o) => this.schedule(o.nextDelayMs));
    }, delayMs);
  }

  /** One poll. Concurrent callers share the in-flight poll. */
  pollOnce(): Promise<PollOutcome> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doPoll().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doPoll(): Promise<PollOutcome> {
    const { db, clock, provider, intervalMs } = this.d;
    const started = clock();
    const pollId = newId(started);
    try {
      const result = await provider.poll(this.abort.signal);
      const finished = clock();
      // Monitoring gap: no successful poll for longer than the threshold (e.g. machine asleep).
      const gapFrom = this.lastSuccessAt;
      this.lastSuccessAt = started;
      this.failures = 0;
      if (gapFrom !== null && started - gapFrom > this.gapThresholdMs) {
        db.prepare("INSERT INTO gaps (run_id, from_ts, to_ts, kind) VALUES (?, ?, ?, 'poll_gap')").run(this.runId, gapFrom, started);
        this.d.log?.(`monitoring gap recorded: ${Math.round((started - gapFrom) / 1000)} s without a successful poll`);
      }
      const warnings = JSON.stringify(result.warnings ?? []);
      if (result === this.lastResult) {
        // The provider served its cached response (polled faster than its minimum): nothing new.
        db.prepare(
          "INSERT INTO polls (id, run_id, poll_started_at, finished_at, status, tokens_tracked, warnings_json) VALUES (?, ?, ?, ?, 'cached', ?, ?)",
        ).run(pollId, this.runId, started, finished, provider.trackedCount(), warnings);
        return this.outcome(pollId, 'cached', 0, 0, 0, result.skipped.length, null, Math.max(0, started + intervalMs - clock()));
      }
      this.lastResult = result;
      let inserted = 0;
      let duplicates = 0;
      let rejected = 0;
      const reject = db.prepare('INSERT INTO rejections (poll_id, at, mint, reason, raw_json) VALUES (?, ?, ?, ?, ?)');
      const latestFor = db.prepare('SELECT MAX(fetched_at) AS t FROM observations WHERE mint = ?');
      const insert = db.prepare(`INSERT OR IGNORE INTO observations (
        run_id, poll_id, mint, fetched_at, poll_started_at, source_ts, pair_created_at, pair_address, dex_id, symbol,
        price_sol, price_usd, quote_reserve_sol, base_reserve, liquidity_usd, volume_5m_sol, volume_1h_sol,
        buys_5m, sells_5m, price_change_5m_pct, price_change_1h_pct, payload_json
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        for (const raw of result.observations) {
          const parsed = MarketObservationSchema.safeParse(raw);
          const mint = (raw as { mint?: unknown })?.mint;
          const mintStr = typeof mint === 'string' ? mint : null;
          if (!parsed.success) {
            rejected++;
            reject.run(pollId, finished, mintStr, `schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, JSON.stringify(raw).slice(0, 4000));
            continue;
          }
          const o: MarketObservation = parsed.data;
          if (o.source !== 'dexscreener' || o.simulated) {
            // Never store simulated data in a recordings database meant for real observations.
            rejected++;
            reject.run(pollId, finished, o.mint, 'not real DexScreener data (simulated or other source)', null);
            continue;
          }
          if (o.observedAt > finished + MAX_FUTURE_SKEW_MS) {
            rejected++;
            reject.run(pollId, finished, o.mint, 'fetch timestamp in the future', null);
            continue;
          }
          const last = (latestFor.get(o.mint) as { t: number | null }).t;
          if (last !== null && o.observedAt < last) {
            rejected++;
            reject.run(pollId, finished, o.mint, `out-of-order: fetched_at ${o.observedAt} < latest ${last}`, null);
            continue;
          }
          const r = insert.run(
            this.runId,
            pollId,
            o.mint,
            o.observedAt,
            started,
            o.pairCreatedAt,
            o.pairAddress,
            o.dexId,
            o.symbol,
            o.priceSol,
            o.priceUsd,
            o.quoteReserveSol,
            o.baseReserve,
            o.liquidityUsd,
            o.volume5mSol,
            o.volume1hSol,
            o.buys5m,
            o.sells5m,
            o.priceChange5mPct,
            o.priceChange1hPct,
            JSON.stringify(o),
          );
          if (r.changes === 0) duplicates++;
          else inserted++;
        }
        db.prepare(
          `INSERT INTO polls (id, run_id, poll_started_at, finished_at, status, tokens_tracked, observations, duplicates, rejected, skipped, warnings_json)
           VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?)`,
        ).run(pollId, this.runId, started, finished, provider.trackedCount(), inserted, duplicates, rejected, result.skipped.length, warnings);
      })();
      this.maybePrune(finished);
      return this.outcome(pollId, 'ok', inserted, duplicates, rejected, result.skipped.length, null, Math.max(0, started + intervalMs - clock()));
    } catch (err) {
      this.failures++;
      const retryAfter = err instanceof ProviderError && err.retryAfterMs !== undefined ? err.retryAfterMs : 0;
      const backoff = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(this.failures, 4));
      const delay = Math.max(intervalMs, backoff, retryAfter);
      const message = this.stopping ? `aborted by shutdown: ${errorMessage(err)}` : errorMessage(err);
      db.prepare(
        "INSERT INTO polls (id, run_id, poll_started_at, finished_at, status, tokens_tracked, error, rate_limited_until) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)",
      ).run(pollId, this.runId, started, clock(), provider.trackedCount(), message, provider.rateLimitedUntil());
      this.d.log?.(`poll failed (${this.failures} in a row): ${message}; next attempt in ${Math.round(delay / 1000)} s`);
      return this.outcome(pollId, 'failed', 0, 0, 0, 0, message, delay);
    }
  }

  private outcome(pollId: string, status: PollOutcome['status'], observations: number, duplicates: number, rejected: number, skipped: number, error: string | null, nextDelayMs: number): PollOutcome {
    return { pollId, status, observations, duplicates, rejected, skipped, error, nextDelayMs };
  }

  private maybePrune(now: number) {
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    pruneOlderThan(this.d.db, now - this.d.retentionDays * 86_400_000);
  }

  /** Stops scheduling, aborts any in-flight request and marks the run as cleanly stopped. Idempotent. */
  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    this.d.db.prepare('UPDATE recorder_runs SET stopped_at = ?, stop_reason = ? WHERE id = ?').run(this.d.clock(), reason, this.runId);
    this.stopped = true;
  }
}

/** Retention: deletes recorder rows older than `cutoff` (recorder database only). */
export function pruneOlderThan(db: Database.Database, cutoff: number): { observations: number; polls: number; rejections: number; gaps: number } {
  return db.transaction(() => ({
    observations: db.prepare('DELETE FROM observations WHERE fetched_at < ?').run(cutoff).changes,
    polls: db.prepare('DELETE FROM polls WHERE poll_started_at < ?').run(cutoff).changes,
    rejections: db.prepare('DELETE FROM rejections WHERE at < ?').run(cutoff).changes,
    gaps: db.prepare('DELETE FROM gaps WHERE to_ts < ?').run(cutoff).changes,
  }))();
}
