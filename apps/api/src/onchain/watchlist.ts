/**
 * Persistent, bounded watchlist of mints for address-level Helius subscriptions.
 *
 * Sources: static mints (ONCHAIN_WATCHLIST, never evicted) and DexScreener discovery candidates.
 * One logsSubscribe per active mint covers the whole lifecycle: pump bonding-curve buy/sell, complete
 * and migrate instructions, and PumpSwap buy/sell, all list the mint (base_mint) account. No
 * program-wide subscription is used.
 *
 * Capacity: at most maxActive mints are active. Over capacity, candidates wait as 'pending'.
 * Discovered mints are evicted when idle (no discovery report and no on-chain event for idleEvictMs),
 * or, under capacity pressure, when they are the least active mint and have been watched for at
 * least minWatchMs. Each active stretch is an onchain_watch_periods row, so coverage is explicit:
 * a mint is covered only inside its watch periods (minus recorded gaps), from first_subscribed_at.
 *
 * Lifecycle: on-chain evidence (events, verified pool accounts) always wins over DexScreener's
 * dexId, which is recorded as 'dexscreener_reported' only.
 */
import type Database from 'better-sqlite3';
import { isBase58Address } from './base58';

export interface WatchCandidate {
  mint: string;
  dexId: string | null;
  pairAddress: string | null;
  pairCreatedAt: number | null;
}

export interface WatchChange {
  added: string[];
  removed: string[];
}

export interface WatchlistOptions {
  db: Database.Database;
  clock: () => number;
  maxActive: number;
  idleEvictMs: number;
  minWatchMs: number;
  staticMints: string[];
  /** Max evictions per rebalance under capacity pressure (limits churn; default 5). */
  maxEvictionsPerRebalance?: number;
}

export interface WatchRow {
  mint: string;
  source: 'static' | 'dexscreener';
  status: 'active' | 'pending' | 'evicted';
  lifecycle: 'bonding_curve' | 'complete' | 'migrated' | 'unknown';
  lifecycle_source: string | null;
  dex_id: string | null;
  pair_address: string | null;
  pool: string | null;
  pair_created_at: number | null;
  first_seen_at: number;
  last_discovered_at: number | null;
  last_event_at: number | null;
  activated_at: number | null;
  first_subscribed_at: number | null;
  evicted_at: number | null;
  evict_reason: string | null;
}

const LIFECYCLE_RANK = { unknown: 0, bonding_curve: 1, complete: 2, migrated: 3 } as const;
type Lifecycle = keyof typeof LIFECYCLE_RANK;

export class WatchlistManager {
  constructor(private readonly o: WatchlistOptions) {
    if (o.staticMints.length > o.maxActive) throw new Error(`ONCHAIN_WATCHLIST has ${o.staticMints.length} mints; the active limit is ${o.maxActive}`);
  }

  get(mint: string): WatchRow | undefined {
    return this.o.db.prepare('SELECT * FROM onchain_watchlist WHERE mint = ?').get(mint) as WatchRow | undefined;
  }

  /** Active mints, static first. */
  active(): string[] {
    return (this.o.db.prepare("SELECT mint FROM onchain_watchlist WHERE status = 'active' ORDER BY source = 'static' DESC, activated_at, mint").all() as { mint: string }[]).map((r) => r.mint);
  }

  /** Registers static mints (activating them) and fills free slots. Returns the active set. */
  init(): string[] {
    const now = this.o.clock();
    this.o.db.transaction(() => {
      for (const mint of this.o.staticMints) {
        this.o.db
          .prepare(
            `INSERT INTO onchain_watchlist (mint, source, status, lifecycle, first_seen_at, updated_at) VALUES (?, 'static', 'pending', 'unknown', ?, ?)
             ON CONFLICT (mint) DO UPDATE SET source = 'static', status = CASE WHEN status = 'active' THEN 'active' ELSE 'pending' END, updated_at = excluded.updated_at`,
          )
          .run(mint, now, now);
        if (this.get(mint)!.status !== 'active') this.activate(mint, now);
      }
      // Mints no longer listed as static become ordinary discovered entries (evictable).
      const listed = new Set(this.o.staticMints);
      for (const r of this.o.db.prepare("SELECT mint FROM onchain_watchlist WHERE source = 'static'").all() as { mint: string }[]) {
        if (!listed.has(r.mint)) this.o.db.prepare("UPDATE onchain_watchlist SET source = 'dexscreener', updated_at = ? WHERE mint = ?").run(now, r.mint);
      }
    })();
    this.rebalance();
    return this.active();
  }

  /** Ingests discovery candidates (deduplicated) and rebalances. Returns PumpSwap pair addresses to verify. */
  ingest(candidates: WatchCandidate[]): WatchChange & { poolHints: { mint: string; pool: string }[] } {
    const now = this.o.clock();
    const poolHints: { mint: string; pool: string }[] = [];
    const seen = new Set<string>();
    this.o.db.transaction(() => {
      for (const c of candidates) {
        if (seen.has(c.mint) || !isBase58Address(c.mint)) continue;
        seen.add(c.mint);
        const reported: Lifecycle = c.dexId === 'pumpfun' ? 'bonding_curve' : c.dexId === 'pumpswap' ? 'migrated' : 'unknown';
        const cur = this.get(c.mint);
        if (!cur) {
          this.o.db
            .prepare(
              `INSERT INTO onchain_watchlist (mint, source, status, lifecycle, lifecycle_source, dex_id, pair_address, pair_created_at, first_seen_at, last_discovered_at, updated_at)
               VALUES (?, 'dexscreener', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(c.mint, reported, reported === 'unknown' ? null : 'dexscreener_reported', c.dexId, c.pairAddress, c.pairCreatedAt, now, now, now);
        } else {
          const upgrade = cur.lifecycle_source !== 'onchain_event' && cur.lifecycle_source !== 'pool_account' && LIFECYCLE_RANK[reported] > LIFECYCLE_RANK[cur.lifecycle];
          this.o.db
            .prepare(
              `UPDATE onchain_watchlist SET dex_id = ?, pair_address = ?, pair_created_at = COALESCE(?, pair_created_at), last_discovered_at = ?,
                 lifecycle = ?, lifecycle_source = ?, status = CASE WHEN status = 'evicted' THEN 'pending' ELSE status END, updated_at = ? WHERE mint = ?`,
            )
            .run(c.dexId, c.pairAddress, c.pairCreatedAt, now, upgrade ? reported : cur.lifecycle, upgrade ? 'dexscreener_reported' : cur.lifecycle_source, now, c.mint);
        }
        if (c.dexId === 'pumpswap' && c.pairAddress && isBase58Address(c.pairAddress)) poolHints.push({ mint: c.mint, pool: c.pairAddress });
      }
    })();
    return { ...this.rebalance(), poolHints };
  }

  /** Applies lifecycle evidence from a decoded on-chain event. */
  noteEvent(e: { eventType: string; mint: string | null; pool: string | null; at: number }): void {
    if (!e.mint) return;
    const cur = this.get(e.mint);
    if (!cur) return;
    const next: Lifecycle | null =
      e.eventType === 'CompletePumpAmmMigrationEvent' || e.eventType === 'CreatePoolEvent' || e.eventType === 'BuyEvent' || e.eventType === 'SellEvent'
        ? 'migrated'
        : e.eventType === 'CompleteEvent'
          ? 'complete'
          : e.eventType === 'TradeEvent' || e.eventType === 'CreateEvent'
            ? 'bonding_curve'
            : null;
    // On-chain evidence replaces a DexScreener report; among on-chain evidence the lifecycle only advances.
    const fromReport = cur.lifecycle_source !== 'onchain_event' && cur.lifecycle_source !== 'pool_account';
    const apply = next !== null && (fromReport || LIFECYCLE_RANK[next] > LIFECYCLE_RANK[cur.lifecycle]);
    this.o.db
      .prepare(
        `UPDATE onchain_watchlist SET last_event_at = MAX(COALESCE(last_event_at, 0), ?), lifecycle = ?, lifecycle_source = ?,
           pool = COALESCE(?, pool), updated_at = ? WHERE mint = ?`,
      )
      .run(e.at, apply ? next : cur.lifecycle, apply ? 'onchain_event' : cur.lifecycle_source, e.eventType === 'BuyEvent' || e.eventType === 'SellEvent' ? null : e.pool, this.o.clock(), e.mint);
  }

  /** A pool verified on-chain belongs to `baseMint`. */
  notePoolResolved(pool: string, baseMint: string, method: string): void {
    const cur = this.get(baseMint);
    if (!cur) return;
    const keepSource = cur.lifecycle_source === 'onchain_event' && cur.lifecycle === 'migrated';
    this.o.db
      .prepare('UPDATE onchain_watchlist SET pool = ?, lifecycle = ?, lifecycle_source = ?, updated_at = ? WHERE mint = ?')
      .run(pool, 'migrated', keepSource ? 'onchain_event' : method === 'onchain_event' ? 'onchain_event' : 'pool_account', this.o.clock(), baseMint);
  }

  noteSubscribed(mint: string, at: number): void {
    this.o.db.prepare('UPDATE onchain_watchlist SET first_subscribed_at = COALESCE(first_subscribed_at, ?) WHERE mint = ?').run(at, mint);
  }

  /** Idle eviction, then fills free slots; under pressure evicts the least active eligible mints. */
  rebalance(): WatchChange {
    const now = this.o.clock();
    const change: WatchChange = { added: [], removed: [] };
    const activity = (r: WatchRow) => Math.max(r.activated_at ?? 0, r.last_discovered_at ?? 0, r.last_event_at ?? 0);
    this.o.db.transaction(() => {
      const active = this.o.db.prepare("SELECT * FROM onchain_watchlist WHERE status = 'active'").all() as WatchRow[];
      for (const r of active) {
        if (r.source !== 'static' && now - activity(r) >= this.o.idleEvictMs) {
          this.evict(r.mint, 'idle', now);
          change.removed.push(r.mint);
        }
      }
      // Over capacity (e.g. static mints were added): shed the least active discovered mints.
      const overflow = (this.o.db.prepare("SELECT * FROM onchain_watchlist WHERE status = 'active' AND source != 'static'").all() as WatchRow[])
        .sort((a, b) => activity(a) - activity(b))
        .slice(0, Math.max(0, this.countActive() - this.o.maxActive));
      for (const r of overflow) {
        this.evict(r.mint, 'capacity', now);
        change.removed.push(r.mint);
      }
      const pending = this.o.db
        .prepare("SELECT * FROM onchain_watchlist WHERE status = 'pending' ORDER BY pair_created_at IS NULL, pair_created_at DESC, first_seen_at DESC")
        .all() as WatchRow[];
      let free = this.o.maxActive - this.countActive();
      let evictions = 0;
      for (const p of pending) {
        if (free <= 0) {
          if (evictions >= (this.o.maxEvictionsPerRebalance ?? 5)) break;
          const victim = (this.o.db.prepare("SELECT * FROM onchain_watchlist WHERE status = 'active' AND source != 'static'").all() as WatchRow[])
            .filter((r) => r.activated_at !== null && now - r.activated_at >= this.o.minWatchMs && activity(r) < activity(p))
            .sort((a, b) => activity(a) - activity(b))[0];
          if (!victim) break;
          this.evict(victim.mint, 'capacity', now);
          change.removed.push(victim.mint);
          evictions++;
          free++;
        }
        this.activate(p.mint, now);
        change.added.push(p.mint);
        free--;
      }
    })();
    return change;
  }

  private countActive(): number {
    return (this.o.db.prepare("SELECT COUNT(*) AS n FROM onchain_watchlist WHERE status = 'active'").get() as { n: number }).n;
  }

  private activate(mint: string, now: number): void {
    this.o.db.prepare("UPDATE onchain_watchlist SET status = 'active', activated_at = ?, evicted_at = NULL, evict_reason = NULL, updated_at = ? WHERE mint = ?").run(now, now, mint);
    this.o.db.prepare('INSERT INTO onchain_watch_periods (mint, from_ts) VALUES (?, ?)').run(mint, now);
  }

  private evict(mint: string, reason: string, now: number): void {
    this.o.db.prepare("UPDATE onchain_watchlist SET status = 'evicted', evicted_at = ?, evict_reason = ?, updated_at = ? WHERE mint = ?").run(now, reason, now, mint);
    this.o.db.prepare('UPDATE onchain_watch_periods SET to_ts = ?, end_reason = ? WHERE mint = ? AND to_ts IS NULL').run(now, reason, mint);
  }
}
