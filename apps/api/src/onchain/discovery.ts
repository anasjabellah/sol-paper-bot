/**
 * Discovery: turns the existing read-only DexScreener provider into watchlist candidates.
 * DexScreener data is a hint for WHAT to watch; it is never used as on-chain evidence.
 */
import { MarketObservationSchema } from '@spb/shared';
import type { DexScreenerProvider } from '../market/dexscreenerProvider';
import type { WatchCandidate, WatchChange, WatchlistManager } from './watchlist';

export interface DiscoverySource {
  discover(): Promise<WatchCandidate[]>;
}

export class DexScreenerDiscovery implements DiscoverySource {
  constructor(private readonly provider: Pick<DexScreenerProvider, 'poll'>) {}

  async discover(): Promise<WatchCandidate[]> {
    const res = await this.provider.poll();
    const out: WatchCandidate[] = [];
    for (const raw of res.observations) {
      const o = MarketObservationSchema.safeParse(raw);
      if (!o.success) continue;
      out.push({ mint: o.data.mint, dexId: o.data.dexId, pairAddress: o.data.pairAddress, pairCreatedAt: o.data.pairCreatedAt });
    }
    return out;
  }
}

export interface SubscriptionTarget {
  addSubscription(address: string): void;
  removeSubscription(address: string): void;
  pools: { hint(pool: string, reportedBy: string): void };
}

/** Applies a watchlist change to the recorder: removals first, so capacity is never exceeded. */
export function applyWatchChange(target: SubscriptionTarget, c: WatchChange): void {
  for (const m of c.removed) target.removeSubscription(m);
  for (const m of c.added) target.addSubscription(m);
}

/**
 * One discovery round: candidates -> watchlist (dedupe, capacity, lifecycle) -> subscriptions.
 * PumpSwap pair addresses reported by DexScreener become pool lookup hints (verified on-chain).
 * On a discovery failure the watchlist is still rebalanced (idle eviction) and nothing is invented.
 */
export async function discoverOnce(
  source: DiscoverySource,
  watchlist: WatchlistManager,
  target: SubscriptionTarget,
): Promise<WatchChange & { hinted: number; error: string | null }> {
  let candidates: WatchCandidate[];
  try {
    candidates = await source.discover();
  } catch (err) {
    const c = watchlist.rebalance();
    applyWatchChange(target, c);
    return { ...c, hinted: 0, error: (err as Error).message };
  }
  const res = watchlist.ingest(candidates);
  for (const h of res.poolHints) target.pools.hint(h.pool, 'dexscreener');
  applyWatchChange(target, res);
  return { added: res.added, removed: res.removed, hinted: res.poolHints.length, error: null };
}
