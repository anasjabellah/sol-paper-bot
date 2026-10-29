import { MOCK_MINT_PREFIX, type MarketObservation } from '@spb/shared';
import type { Clock } from '../lib/util';
import { ProviderError, type MarketDataProvider, type ProviderPollResult } from './provider';

/** Deterministic PRNG (mulberry32) so simulations are reproducible from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Regime = 'accumulate' | 'pump' | 'drift' | 'dump' | 'dead';

interface SimTrade {
  ts: number;
  sol: number;
  side: 'buy' | 'sell';
}

interface SimToken {
  id: number;
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  q: number; // SOL reserve
  b: number; // token reserve
  regime: Regime;
  regimeUntil: number;
  trades: SimTrade[];
  prices: { ts: number; price: number }[];
}

const STEP_MS = 1000;
const MAX_CATCHUP_STEPS = 900;
const HOUR = 3_600_000;
const FIVE_MIN = 300_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface MockProviderOptions {
  seed: number;
  tokenCount: number;
  clock: Clock;
  failureRate?: number;
  /** Minutes of history simulated before the first poll so rolling stats are populated. */
  warmupMinutes?: number;
}

/**
 * SIMULATED market. Each token is an x*y=k pool driven by random buy/sell flow
 * whose bias depends on a regime (accumulate, pump, drift, dump, dead/rug).
 * Every observation is flagged `simulated: true` and uses a `mock_` mint prefix.
 */
export class MockMarketProvider implements MarketDataProvider {
  readonly name = 'mock' as const;
  readonly simulated = true;
  readonly minPollIntervalMs = 1000;
  private readonly rng: () => number;
  private readonly tokens: SimToken[] = [];
  private nextId = 1;
  private simTime: number;
  private frozenAt: number | null = null;
  private readonly failureRate: number;
  /**
   * Identifies this simulation run (base36 start time). It is part of every mint so a
   * new run - e.g. after an API restart - can never reuse the identity of a token from
   * an earlier run and silently re-price positions opened on it. Same start time =>
   * same run id, so seeded runs stay reproducible.
   */
  readonly runId: string;

  constructor(private readonly opts: MockProviderOptions) {
    this.rng = mulberry32(opts.seed);
    this.failureRate = opts.failureRate ?? 0;
    const now = opts.clock();
    this.runId = Math.floor(now).toString(36);
    const warmup = (opts.warmupMinutes ?? 15) * 60_000;
    this.simTime = now - warmup;
    for (let i = 0; i < opts.tokenCount; i++) {
      // Backdate creation so tokens have a spread of ages.
      this.tokens.push(this.spawn(this.simTime - Math.floor(this.rng() * 6 * HOUR)));
    }
    this.advanceTo(now, Number.POSITIVE_INFINITY);
  }

  describe() {
    return `Deterministic simulated market (seed ${this.opts.seed}, run ${this.runId}, ${this.tokens.length} tokens). NOT live data.`;
  }
  trackedCount() {
    return this.tokens.length;
  }
  rateLimitedUntil() {
    return null;
  }
  discoveryStatus() {
    return [];
  }
  isTracking(mint: string) {
    return this.tokens.some((t) => t.mint === mint);
  }

  /** Test hook: stop advancing so observations become stale. */
  freeze(frozen: boolean) {
    this.frozenAt = frozen ? this.simTime : null;
  }

  async poll(): Promise<ProviderPollResult> {
    if (this.failureRate > 0 && this.rng() < this.failureRate) {
      throw new ProviderError('simulated provider outage (MOCK_FAILURE_RATE)', true);
    }
    if (this.frozenAt === null) this.advanceTo(this.opts.clock(), MAX_CATCHUP_STEPS);
    return { observations: this.tokens.map((t) => this.observe(t)), skipped: [] };
  }

  private spawn(createdAt: number): SimToken {
    const id = this.nextId++;
    const sym = Array.from({ length: 3 }, () => ALPHABET[Math.floor(this.rng() * ALPHABET.length)]).join('');
    const q = 30 + this.rng() * 170;
    const price = 2e-8 + this.rng() * 3e-7;
    const t: SimToken = {
      id,
      mint: `${MOCK_MINT_PREFIX}${this.runId}_${id.toString().padStart(4, '0')}${sym.toLowerCase()}`,
      symbol: `SIM-${sym}`,
      name: `Simulated Token ${sym}`,
      createdAt,
      q,
      b: q / price,
      regime: 'drift',
      regimeUntil: createdAt,
      trades: [],
      prices: [{ ts: createdAt, price }],
    };
    return t;
  }

  private pickRegime(t: SimToken, now: number) {
    const r = this.rng();
    let regime: Regime;
    if (r < 0.2) regime = 'pump';
    else if (r < 0.35) regime = 'accumulate';
    else if (r < 0.65) regime = 'drift';
    else if (r < 0.93) regime = 'dump';
    else regime = 'dead';
    t.regime = regime;
    t.regimeUntil = now + (60 + Math.floor(this.rng() * 360)) * 1000;
    if (regime === 'dead') {
      // "Rug": most liquidity is pulled; price collapses with it.
      t.q *= 0.08;
      t.b *= 0.5;
    }
  }

  private step(t: SimToken, now: number) {
    if (now >= t.regimeUntil) this.pickRegime(t, now);
    const params: Record<Regime, { rate: number; buyP: number; size: number }> = {
      accumulate: { rate: 0.5, buyP: 0.57, size: 0.4 },
      pump: { rate: 1.6, buyP: 0.64, size: 0.8 },
      drift: { rate: 0.35, buyP: 0.5, size: 0.3 },
      dump: { rate: 0.9, buyP: 0.36, size: 0.6 },
      dead: { rate: 0.05, buyP: 0.3, size: 0.05 },
    };
    const p = params[t.regime];
    // Poisson-ish count of trades this second.
    let n = 0;
    const acc = Math.exp(-p.rate);
    let prod = this.rng();
    while (prod > acc && n < 8) {
      n++;
      prod *= this.rng();
    }
    for (let i = 0; i < n; i++) {
      const side = this.rng() < p.buyP ? 'buy' : 'sell';
      const sol = Math.min(p.size * -Math.log(1 - this.rng() * 0.999), t.q * 0.2);
      const k = t.q * t.b;
      if (side === 'buy') {
        t.q += sol;
        t.b = k / t.q;
      } else {
        if (t.q - sol < 0.5) continue;
        t.q -= sol;
        t.b = k / t.q;
      }
      t.trades.push({ ts: now, sol, side });
    }
    t.prices.push({ ts: now, price: t.q / t.b });
  }

  private advanceTo(target: number, maxSteps: number) {
    let steps = 0;
    while (this.simTime + STEP_MS <= target && steps < maxSteps) {
      this.simTime += STEP_MS;
      steps++;
      for (const t of this.tokens) this.step(t, this.simTime);
    }
    // After a long gap (e.g. laptop sleep) jump forward instead of simulating every second.
    if (this.simTime + STEP_MS <= target) this.simTime = target;
    this.recycleDeadTokens();
    for (const t of this.tokens) {
      const cutoff = this.simTime - HOUR;
      if (t.trades.length && t.trades[0].ts < cutoff) t.trades = t.trades.filter((x) => x.ts >= cutoff);
      if (t.prices.length > 1 && t.prices[0].ts < cutoff) t.prices = t.prices.filter((x) => x.ts >= cutoff);
    }
  }

  /** Replace long-dead tokens with freshly launched ones so discovery keeps happening. */
  private recycleDeadTokens() {
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.regime === 'dead' && this.simTime >= t.regimeUntil - 1000 && this.rng() < 0.5) {
        this.tokens[i] = this.spawn(this.simTime);
      }
    }
  }

  private priceAt(t: SimToken, ts: number): number {
    // Latest sample at or before ts; falls back to the earliest sample we have.
    let candidate = t.prices[0].price;
    for (const s of t.prices) {
      if (s.ts > ts) break;
      candidate = s.price;
    }
    return candidate;
  }

  private observe(t: SimToken): MarketObservation {
    const now = this.simTime;
    const price = t.q / t.b;
    const w5 = t.trades.filter((x) => x.ts > now - FIVE_MIN);
    const vol = (arr: SimTrade[]) => arr.reduce((s, x) => s + x.sol, 0);
    const change = (window: number) => {
      // Only report a change if we actually have history covering the window or since creation.
      const from = Math.max(now - window, t.createdAt);
      if (t.prices[0].ts > from + STEP_MS) return null;
      const past = this.priceAt(t, from);
      return ((price - past) / past) * 100;
    };
    return {
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      source: 'mock',
      simulated: true,
      observedAt: this.frozenAt ?? now,
      priceSol: price,
      priceUsd: null,
      quoteReserveSol: t.q,
      baseReserve: t.b,
      liquidityUsd: null,
      volume5mSol: vol(w5),
      volume1hSol: vol(t.trades),
      buys5m: w5.filter((x) => x.side === 'buy').length,
      sells5m: w5.filter((x) => x.side === 'sell').length,
      priceChange5mPct: change(FIVE_MIN),
      priceChange1hPct: change(HOUR),
      pairCreatedAt: t.createdAt,
      pairAddress: null,
      dexId: 'mock-amm',
      url: null,
    };
  }
}
