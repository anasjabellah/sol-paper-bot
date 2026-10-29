import { MarketObservationSchema, type MarketObservation, type ProviderHealth } from '@spb/shared';
import type { AuditLogger } from '../logging/audit';
import type { Repository } from '../database/repository';
import { errorMessage, type Clock } from '../lib/util';
import { ProviderError, type MarketDataProvider } from './provider';

/** Clock skew tolerated for timestamps slightly in the future. */
const MAX_FUTURE_SKEW_MS = 5_000;
/** Tokens not refreshed for this long are dropped from the latest view. */
const EVICT_AFTER_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 120_000;

export function isStale(obs: MarketObservation, now: number, maxAgeMs: number): boolean {
  return now - obs.observedAt > maxAgeMs;
}

export interface MarketServiceOptions {
  pollIntervalMs: number;
  /** Persist observations for later "recorded" backtests every N ms (0 = never). */
  recordEveryMs: number;
}

/**
 * Owns the provider: polls it with exponential backoff, validates every
 * observation, keeps the latest valid snapshot per token and reports health.
 */
export class MarketDataService {
  private readonly latest = new Map<string, MarketObservation>();
  private consecutiveFailures = 0;
  private lastSuccessAt: number | null = null;
  private lastAttemptAt: number | null = null;
  private lastError: string | null = null;
  private nextPollAt = 0;
  private rejected = 0;
  private lastRecordedAt = 0;
  private inFlight: Promise<void> | null = null;
  private warnings: string[] = [];
  private readonly changedAt = new Map<string, number>();
  private generation = 0;
  /** Mints present in the most recent successful poll (frame membership for next-bar fills). */
  private lastPollMints = new Set<string>();

  constructor(
    private current: MarketDataProvider,
    private readonly repo: Repository,
    private readonly audit: AuditLogger,
    private readonly clock: Clock,
    private readonly opts: MarketServiceOptions,
  ) {}

  get provider(): MarketDataProvider {
    return this.current;
  }

  /** Effective poll interval: configured interval, never faster than the provider allows. */
  pollIntervalMs(): number {
    return Math.max(this.opts.pollIntervalMs, this.current.minPollIntervalMs);
  }

  /**
   * Swap the data source at runtime. All observations from the previous provider
   * are discarded so mock and real records can never be mixed.
   */
  async setProvider(next: MarketDataProvider): Promise<void> {
    this.generation++;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    this.current = next;
    this.latest.clear();
    this.changedAt.clear();
    this.lastPollMints.clear();
    this.consecutiveFailures = 0;
    this.lastSuccessAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.nextPollAt = 0;
    this.rejected = 0;
    this.warnings = [];
  }

  /** Poll if due. Concurrent callers share the same in-flight request. */
  refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.clock() < this.nextPollAt) return Promise.resolve();
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const started = this.clock();
    const generation = this.generation;
    const provider = this.current;
    this.lastAttemptAt = started;
    try {
      const result = await provider.poll();
      // Provider was switched while this poll was in flight: drop the stale result.
      if (generation !== this.generation) return;
      const now = this.clock();
      const accepted: MarketObservation[] = [];
      const invalid: { mint: unknown; issues: string[] }[] = [];
      for (const raw of result.observations) {
        const parsed = MarketObservationSchema.safeParse(raw);
        if (!parsed.success) {
          invalid.push({
            mint: (raw as { mint?: unknown })?.mint,
            issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
          });
          continue;
        }
        const obs = parsed.data;
        if (obs.source !== provider.name || obs.simulated !== provider.simulated) {
          invalid.push({ mint: obs.mint, issues: [`record source ${obs.source} does not match active provider ${provider.name}`] });
          continue;
        }
        if (obs.observedAt > now + MAX_FUTURE_SKEW_MS) {
          invalid.push({ mint: obs.mint, issues: ['observedAt is in the future'] });
          continue;
        }
        const prev = this.latest.get(obs.mint);
        if (prev && obs.observedAt < prev.observedAt) {
          invalid.push({ mint: obs.mint, issues: ['out-of-order observation (older than latest)'] });
          continue;
        }
        accepted.push(obs);
        if (!prev || marketFieldsChanged(prev, obs)) this.changedAt.set(obs.mint, obs.observedAt);
        this.latest.set(obs.mint, obs);
      }
      if (invalid.length) {
        this.rejected += invalid.length;
        await this.audit.warn('market.invalid_observations', `Rejected ${invalid.length} invalid observation(s)`, {
          sample: invalid.slice(0, 5),
        });
      }
      for (const [mint, o] of this.latest) {
        if (now - o.observedAt > EVICT_AFTER_MS) {
          this.latest.delete(mint);
          this.changedAt.delete(mint);
        }
      }
      // Frame membership for next-bar fills: only mints in this successful poll (not the retained cache).
      this.lastPollMints = new Set(accepted.map((o) => o.mint));

      if (this.consecutiveFailures > 0) {
        await this.audit.info('market.recovered', `Market data recovered after ${this.consecutiveFailures} failure(s)`);
      }
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSuccessAt = now;
      this.nextPollAt = started + this.pollIntervalMs();
      this.warnings = (result.warnings ?? []).slice(0, 10);

      if (this.opts.recordEveryMs > 0 && now - this.lastRecordedAt >= this.opts.recordEveryMs && accepted.length) {
        this.lastRecordedAt = now;
        await this.repo.insertObservations(accepted);
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.consecutiveFailures++;
      this.lastError = errorMessage(err);
      const backoff = Math.min(MAX_BACKOFF_MS, this.pollIntervalMs() * 2 ** Math.min(this.consecutiveFailures, 6));
      const retryAfter = err instanceof ProviderError && err.retryAfterMs ? err.retryAfterMs : 0;
      this.nextPollAt = this.clock() + Math.max(backoff, retryAfter);
      // Log the first failure and then every 5th to avoid flooding the audit log.
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 5 === 0) {
        await this.audit.error('market.poll_failed', `Market data poll failed: ${this.lastError}`, {
          consecutiveFailures: this.consecutiveFailures,
          retryInMs: this.nextPollAt - this.clock(),
        });
      }
    }
  }

  /** When the market fields of this token last changed (not merely re-fetched). */
  lastChangedAt(mint: string): number | null {
    return this.changedAt.get(mint) ?? null;
  }

  /** False once the provider no longer refreshes this token (e.g. dropped from discovery tracking). */
  isTracked(mint: string): boolean {
    return this.current.isTracking ? this.current.isTracking(mint) : true;
  }

  get(mint: string): MarketObservation | undefined {
    return this.latest.get(mint);
  }

  all(): MarketObservation[] {
    return [...this.latest.values()];
  }

  /**
   * True when the mint appeared in the latest successful provider poll.
   * Used by next-bar fills so a token retained only in the cache (not in this
   * poll/frame) is treated as absent — matching backtest frame membership.
   */
  wasInLastPoll(mint: string): boolean {
    return this.lastPollMints.has(mint);
  }

  health(): ProviderHealth {
    const now = this.clock();
    let state: ProviderHealth['state'];
    // 'ok' requires an actual successful poll; a first request still in flight is 'starting'.
    if (this.consecutiveFailures === 0 && this.lastSuccessAt === null) state = 'starting';
    else if (this.consecutiveFailures === 0) state = 'ok';
    else if (this.consecutiveFailures < 3 && this.lastSuccessAt !== null) state = 'degraded';
    else state = 'down';
    return {
      provider: this.current.name,
      simulated: this.current.simulated,
      state,
      lastSuccessAt: this.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      nextPollAt: this.nextPollAt > now ? this.nextPollAt : null,
      trackedTokens: this.current.trackedCount(),
      rejectedObservations: this.rejected,
      rateLimitedUntil: this.current.rateLimitedUntil(),
      detail: this.current.describe(),
      pollIntervalMs: this.pollIntervalMs(),
      discovery: this.current.discoveryStatus(),
      warnings: this.warnings,
    };
  }
}

/** Fields that indicate the source's market data actually moved between fetches. */
function marketFieldsChanged(a: MarketObservation, b: MarketObservation): boolean {
  return (
    a.priceSol !== b.priceSol ||
    a.quoteReserveSol !== b.quoteReserveSol ||
    a.baseReserve !== b.baseReserve ||
    a.volume5mSol !== b.volume5mSol ||
    a.buys5m !== b.buys5m ||
    a.sells5m !== b.sells5m ||
    a.priceChange5mPct !== b.priceChange5mPct
  );
}
