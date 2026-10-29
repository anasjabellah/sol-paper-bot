import { z } from 'zod';
import { BASE58_ADDRESS_RE, WSOL_MINT, type DiscoverySourceStatus, type MarketObservation } from '@spb/shared';
import { errorMessage, type Clock } from '../lib/util';
import { ProviderError, type MarketDataProvider, type ProviderPollResult } from './provider';

/**
 * READ-ONLY adapter for the public DexScreener API (https://docs.dexscreener.com/api/reference).
 * Only documented GET endpoints are used (verified against the reference, 2026-10):
 *
 *   Discovery (each 60 req/min):
 *     GET /token-profiles/latest/v1        latest tokens with a (paid) DexScreener profile
 *     GET /token-boosts/latest/v1          latest boosted tokens
 *     GET /token-boosts/top/v1             tokens with the most active boosts
 *     GET /community-takeovers/latest/v1   latest community takeovers
 *   Discovery heuristic (300 req/min):
 *     GET /latest/dex/search?q={query}     pairs matching a text query (relevance-ranked, max ~30)
 *   Pair data (300 req/min):
 *     GET /tokens/v1/solana/{addresses}    pairs for up to 30 comma-separated token addresses
 *
 * DexScreener has NO documented "new pump.fun launches" feed; see docs/DATA_SOURCES.md
 * for coverage. Data-quality notes observed in live responses:
 *   - pump.fun bonding-curve pairs (dexId "pumpfun") carry NO `liquidity` object, so
 *     reserves are null and such tokens are observation-only (no simulated fills).
 *   - Graduated PumpSwap pairs (dexId "pumpswap") include `liquidity.base/quote`.
 *   - Responses carry no data timestamp; freshness is measured from fetch time.
 */

const num = z.union([z.number(), z.string()]).optional().nullable();
const PairSchema = z
  .object({
    chainId: z.string(),
    dexId: z.string(),
    url: z.string().optional().nullable(),
    pairAddress: z.string(),
    baseToken: z.object({ address: z.string(), name: z.string().optional().nullable(), symbol: z.string().optional().nullable() }),
    quoteToken: z.object({ address: z.string().optional().nullable(), symbol: z.string().optional().nullable() }).optional().nullable(),
    priceNative: num,
    priceUsd: num,
    txns: z.record(z.object({ buys: z.number().optional().nullable(), sells: z.number().optional().nullable() }).passthrough()).optional().nullable(),
    volume: z.record(z.number().nullable()).optional().nullable(),
    priceChange: z.record(z.number().nullable()).optional().nullable(),
    liquidity: z.object({ usd: num, base: num, quote: num }).passthrough().optional().nullable(),
    pairCreatedAt: z.number().optional().nullable(),
  })
  .passthrough();
type Pair = z.infer<typeof PairSchema>;

const TokenListSchema = z.array(z.object({ chainId: z.string(), tokenAddress: z.string() }).passthrough());
const SearchSchema = z.object({ pairs: z.array(z.unknown()).nullable().optional() }).passthrough();

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const positiveOrNull = (v: unknown) => {
  const n = toNum(v);
  return n !== null && n > 0 ? n : null;
};
const nonNegOrNull = (v: unknown) => {
  const n = toNum(v);
  return n !== null && n >= 0 ? n : null;
};

/** Sliding-window limiter so we stay well under documented limits. */
class WindowLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  tryTake(now: number): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
}

interface DiscoverySource {
  name: string;
  path: string;
  kind: 'list' | 'search';
  limiter: WindowLimiter;
}

export interface DexScreenerOptions {
  baseUrl: string;
  dexIds: string[];
  watchlist: string[];
  maxTracked: number;
  discoveryIntervalMs: number;
  /** Free-text queries for /latest/dex/search discovery (e.g. "pumpfun"). */
  searchQueries?: string[];
  /** Minimum interval between pair-data fetches; faster polls are served from cache. */
  minPollIntervalMs?: number;
  clock: Clock;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Delays before each retry of a retryable failure (network, timeout, 5xx, bad JSON). */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export class DexScreenerProvider implements MarketDataProvider {
  readonly name = 'dexscreener' as const;
  readonly simulated = false;
  readonly minPollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Insertion-ordered map used as an LRU of discovered tokens (newest last). */
  private readonly tracked = new Map<string, number>();
  /** Whether each tracked mint's last fetched pair carried pool reserves (eviction priority). */
  private readonly hasReserves = new Map<string, boolean>();
  private pinned = new Set<string>();
  private lastDiscoveryAt = 0;
  private cooldownUntil: number | null = null;
  // Budgets at roughly half of the documented per-minute limits.
  private readonly listLimiter = new WindowLimiter(30, 60_000);
  private readonly pairsLimiter = new WindowLimiter(150, 60_000);
  private readonly sources: DiscoverySource[];
  private readonly sourceStatus = new Map<string, DiscoverySourceStatus>();
  private cache: { at: number; result: ProviderPollResult } | null = null;

  constructor(private readonly opts: DexScreenerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minPollIntervalMs = opts.minPollIntervalMs ?? 10_000;
    for (const mint of opts.watchlist) {
      if (!BASE58_ADDRESS_RE.test(mint)) throw new Error(`DEXSCREENER_WATCHLIST entry is not a valid mint address: ${mint}`);
    }
    this.sources = [
      { name: 'token-profiles/latest', path: '/token-profiles/latest/v1', kind: 'list', limiter: this.listLimiter },
      { name: 'token-boosts/latest', path: '/token-boosts/latest/v1', kind: 'list', limiter: this.listLimiter },
      { name: 'token-boosts/top', path: '/token-boosts/top/v1', kind: 'list', limiter: this.listLimiter },
      { name: 'community-takeovers/latest', path: '/community-takeovers/latest/v1', kind: 'list', limiter: this.listLimiter },
      ...(opts.searchQueries ?? []).map((q) => ({
        name: `search:${q}`,
        path: `/latest/dex/search?q=${encodeURIComponent(q)}`,
        kind: 'search' as const,
        limiter: this.pairsLimiter,
      })),
    ];
    for (const s of this.sources) this.sourceStatus.set(s.name, { source: s.name, lastOkAt: null, lastCount: null, lastError: null });
  }

  describe() {
    const dex = this.opts.dexIds.length ? this.opts.dexIds.join(', ') : 'any';
    return `DexScreener public API (read-only, real market data). SOL-quoted pairs on dexIds: ${dex}.`;
  }
  trackedCount() {
    return new Set([...this.opts.watchlist, ...this.pinned, ...this.tracked.keys()]).size;
  }
  /** True while the mint's pair data is still requested on every poll. */
  isTracking(mint: string): boolean {
    return this.opts.watchlist.includes(mint) || this.pinned.has(mint) || this.tracked.has(mint);
  }
  /**
   * Mints that must be refreshed on every poll regardless of discovery churn
   * (open paper positions: they must stay priceable so exits can be evaluated).
   */
  setPinnedMints(mints: string[]): void {
    this.pinned = new Set(mints.filter((m) => BASE58_ADDRESS_RE.test(m)));
  }
  rateLimitedUntil() {
    return this.cooldownUntil && this.cooldownUntil > this.opts.clock() ? this.cooldownUntil : null;
  }
  discoveryStatus(): DiscoverySourceStatus[] {
    return [...this.sourceStatus.values()].map((s) => ({ ...s }));
  }

  /** GET with timeout and bounded retries for transient failures. 429s are never retried immediately. */
  private async getJson(path: string, limiter: WindowLimiter, signal?: AbortSignal): Promise<unknown> {
    const delays = this.opts.retryDelaysMs ?? [750, 2000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.getJsonOnce(path, limiter, signal);
      } catch (err) {
        const retryable = err instanceof ProviderError && err.retryable && err.retryAfterMs === undefined;
        if (!retryable || attempt >= delays.length || signal?.aborted) throw err;
        await this.sleep(delays[attempt]);
      }
    }
  }

  private async getJsonOnce(path: string, limiter: WindowLimiter, signal?: AbortSignal): Promise<unknown> {
    const now = this.opts.clock();
    if (this.cooldownUntil && now < this.cooldownUntil) {
      throw new ProviderError('rate-limited by provider; waiting before retry', true, this.cooldownUntil - now);
    }
    if (!limiter.tryTake(now)) throw new ProviderError('local rate budget exhausted; deferring request', true, 5_000);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 10_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: combined,
      });
    } catch (err) {
      const timedOut = timeout.aborted && !signal?.aborted;
      throw new ProviderError(timedOut ? 'request timed out' : `network error: ${errorMessage(err)}`, true);
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000;
      this.cooldownUntil = this.opts.clock() + waitMs;
      throw new ProviderError('HTTP 429 rate limited', true, waitMs);
    }
    if (res.status >= 500) throw new ProviderError(`HTTP ${res.status} from provider`, true);
    if (!res.ok) throw new ProviderError(`HTTP ${res.status} from provider`, false);
    try {
      return await res.json();
    } catch {
      throw new ProviderError('provider returned invalid JSON', true);
    }
  }

  private track(mint: string, now: number) {
    this.tracked.delete(mint);
    this.tracked.set(mint, now);
  }

  /** Query every discovery source; one failing source never blocks the others. */
  private async discover(signal?: AbortSignal): Promise<string[]> {
    const now = this.opts.clock();
    if (now - this.lastDiscoveryAt < this.opts.discoveryIntervalMs) return [];
    this.lastDiscoveryAt = now;
    const warnings: string[] = [];
    for (const src of this.sources) {
      const status = this.sourceStatus.get(src.name)!;
      try {
        const raw = await this.getJson(src.path, src.limiter, signal);
        const mints = src.kind === 'list' ? this.parseList(raw) : this.parseSearch(raw);
        for (const m of mints) this.track(m, now);
        Object.assign(status, { lastOkAt: this.opts.clock(), lastCount: mints.length, lastError: null });
      } catch (err) {
        status.lastError = errorMessage(err);
        warnings.push(`discovery ${src.name}: ${status.lastError}`);
        // Once the provider rate-limits us, stop hitting further sources this round.
        if (err instanceof ProviderError && err.message.startsWith('HTTP 429')) break;
      }
    }
    this.enforceTrackedCap();
    return warnings;
  }

  /**
   * Keep the tracked set within DEXSCREENER_MAX_TRACKED without dropping useful tokens.
   * Eviction order: tokens last seen WITHOUT pool reserves (observation-only), then
   * never-fetched discoveries, then tokens with reserves; oldest first within each group.
   * Pinned (held) and watchlist mints are never evicted.
   */
  private enforceTrackedCap() {
    const excess = this.tracked.size - this.opts.maxTracked;
    if (excess <= 0) return;
    const rank = (m: string) => (this.hasReserves.get(m) === false ? 0 : this.hasReserves.has(m) ? 2 : 1);
    const evictable = [...this.tracked.keys()].filter((m) => !this.pinned.has(m) && !this.opts.watchlist.includes(m));
    // Array.prototype.sort is stable, so insertion (age) order is kept within a rank.
    for (const m of evictable.sort((a, b) => rank(a) - rank(b)).slice(0, excess)) {
      this.tracked.delete(m);
      this.hasReserves.delete(m);
    }
  }

  private parseList(raw: unknown): string[] {
    const parsed = TokenListSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('unexpected discovery response shape', false);
    return parsed.data.filter((i) => i.chainId === 'solana' && BASE58_ADDRESS_RE.test(i.tokenAddress)).map((i) => i.tokenAddress);
  }

  private parseSearch(raw: unknown): string[] {
    const parsed = SearchSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('unexpected search response shape', false);
    const out: string[] = [];
    for (const item of parsed.data.pairs ?? []) {
      const p = PairSchema.safeParse(item);
      if (!p.success || p.data.chainId !== 'solana') continue;
      if (this.opts.dexIds.length && !this.opts.dexIds.includes(p.data.dexId)) continue;
      if (BASE58_ADDRESS_RE.test(p.data.baseToken.address)) out.push(p.data.baseToken.address);
    }
    return out;
  }

  async poll(signal?: AbortSignal): Promise<ProviderPollResult> {
    const now = this.opts.clock();
    // Serve from cache when polled faster than the provider minimum (protects the rate limit).
    if (this.cache && now - this.cache.at < this.minPollIntervalMs) return this.cache.result;

    const warnings = await this.discover(signal);
    // Discovery only decides WHICH tokens are tracked; every tracked token's pair data is
    // re-fetched on every poll below. Pinned/watchlist first, then newest discoveries.
    const mints = [...new Set([...this.opts.watchlist, ...this.pinned, ...[...this.tracked.keys()].reverse()])];
    if (mints.length === 0) {
      if (warnings.length) throw new ProviderError(`no tokens to track: ${warnings.join('; ')}`, true);
      return { observations: [], skipped: [], warnings };
    }

    const observations: unknown[] = [];
    const skipped: { id: string; reason: string }[] = [];
    let failedChunks = 0;
    let lastError: unknown;
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

    for (const chunk of chunks) {
      let raw: unknown;
      try {
        raw = await this.getJson(`/tokens/v1/solana/${chunk.join(',')}`, this.pairsLimiter, signal);
        if (!Array.isArray(raw)) throw new ProviderError('unexpected response shape from /tokens/v1', true);
      } catch (err) {
        failedChunks++;
        lastError = err;
        warnings.push(`pair data chunk failed: ${errorMessage(err)}`);
        if (err instanceof ProviderError && err.retryAfterMs !== undefined) break; // rate limited: stop now
        continue;
      }
      const fetchedAt = this.opts.clock();
      const byMint = new Map<string, Pair[]>();
      let malformed = 0;
      for (const item of raw as unknown[]) {
        const p = PairSchema.safeParse(item);
        if (!p.success) {
          malformed++;
          continue;
        }
        const list = byMint.get(p.data.baseToken.address) ?? [];
        list.push(p.data);
        byMint.set(p.data.baseToken.address, list);
      }
      if (malformed) warnings.push(`${malformed} malformed pair record(s) ignored`);
      for (const mint of chunk) {
        const pair = this.selectPair(byMint.get(mint) ?? []);
        if (!pair) {
          skipped.push({ id: mint, reason: 'no SOL-quoted pair on an allowed dex' });
          // Free the slot for other discoveries (watchlist and pinned entries are always kept).
          if (!this.opts.watchlist.includes(mint) && !this.pinned.has(mint)) this.tracked.delete(mint);
          continue;
        }
        const obs = mapPair(pair, fetchedAt);
        if (this.tracked.has(mint)) this.hasReserves.set(mint, obs.quoteReserveSol !== null);
        observations.push(obs);
      }
    }
    if (failedChunks > 0 && failedChunks >= chunks.length) throw lastError;
    const result = { observations, skipped, warnings };
    this.cache = { at: now, result };
    return result;
  }

  /** Prefer the deepest SOL-quoted pair on an allowed dex. */
  private selectPair(pairs: Pair[]): Pair | undefined {
    const allowed = pairs.filter(
      (p) =>
        p.chainId === 'solana' &&
        p.quoteToken?.address === WSOL_MINT &&
        (this.opts.dexIds.length === 0 || this.opts.dexIds.includes(p.dexId)),
    );
    return allowed.sort((a, b) => (toNum(b.liquidity?.quote) ?? -1) - (toNum(a.liquidity?.quote) ?? -1))[0];
  }
}

/** Map a DexScreener pair to a normalized observation. Missing fields become null, never 0. */
export function mapPair(p: Pair, fetchedAt: number): MarketObservation {
  const priceSol = positiveOrNull(p.priceNative);
  const priceUsd = positiveOrNull(p.priceUsd);
  const solUsd = priceSol && priceUsd ? priceUsd / priceSol : null;
  const usdToSol = (v: unknown) => {
    const n = nonNegOrNull(v);
    return n !== null && solUsd ? n / solUsd : null;
  };
  const m5 = p.txns?.m5;
  // A reserve pair is only meaningful if both sides are present.
  const quote = nonNegOrNull(p.liquidity?.quote);
  const base = nonNegOrNull(p.liquidity?.base);
  const haveReserves = quote !== null && base !== null;
  return {
    mint: p.baseToken.address,
    symbol: (p.baseToken.symbol ?? '?').slice(0, 32),
    name: (p.baseToken.name ?? '').slice(0, 128),
    source: 'dexscreener',
    simulated: false,
    observedAt: fetchedAt,
    priceSol,
    priceUsd,
    quoteReserveSol: haveReserves ? quote : null,
    baseReserve: haveReserves ? base : null,
    liquidityUsd: nonNegOrNull(p.liquidity?.usd),
    volume5mSol: usdToSol(p.volume?.m5),
    volume1hSol: usdToSol(p.volume?.h1),
    buys5m: m5 && typeof m5.buys === 'number' && Number.isInteger(m5.buys) && m5.buys >= 0 ? m5.buys : null,
    sells5m: m5 && typeof m5.sells === 'number' && Number.isInteger(m5.sells) && m5.sells >= 0 ? m5.sells : null,
    priceChange5mPct: clampChange(p.priceChange?.m5),
    priceChange1hPct: clampChange(p.priceChange?.h1),
    pairCreatedAt: p.pairCreatedAt && p.pairCreatedAt > 0 ? Math.floor(p.pairCreatedAt) : null,
    pairAddress: p.pairAddress.slice(0, 64),
    dexId: p.dexId.slice(0, 32),
    url: p.url && /^https:\/\//.test(p.url) ? p.url.slice(0, 256) : null,
  };
}

function clampChange(v: unknown): number | null {
  const n = toNum(v);
  if (n === null || n < -100) return null;
  return n;
}
