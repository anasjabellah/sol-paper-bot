import type { DiscoverySourceStatus, MarketSource } from '@spb/shared';

/**
 * Raw output of a provider poll. Observations are `unknown` on purpose: the
 * MarketDataService validates every record with Zod before anything uses it.
 */
export interface ProviderPollResult {
  observations: unknown[];
  /** Tokens the provider could not map (e.g. no SOL-quoted pair) - informational. */
  skipped: { id: string; reason: string }[];
  /** Non-fatal problems during this poll (e.g. one of several requests failed). */
  warnings?: string[];
}

/** READ-ONLY market data source. Implementations must never sign or send transactions. */
export interface MarketDataProvider {
  readonly name: MarketSource;
  readonly simulated: boolean;
  /** Lower bound on the interval between polls, protecting upstream rate limits. */
  readonly minPollIntervalMs: number;
  poll(signal?: AbortSignal): Promise<ProviderPollResult>;
  /** Number of tokens currently tracked (after discovery). */
  trackedCount(): number;
  /** Earliest time the provider allows another request (rate limit), if any. */
  rateLimitedUntil(): number | null;
  /** Per-source discovery health (empty for providers without discovery). */
  discoveryStatus(): DiscoverySourceStatus[];
  describe(): string;
  /** Whether the provider still refreshes this mint (false once dropped from its tracked set). */
  isTracking?(mint: string): boolean;
  /** Mints that must be refreshed on every poll (open positions). */
  setPinnedMints?(mints: string[]): void;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
