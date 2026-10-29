/**
 * Resolves PumpSwap pool -> (base mint, quote mint) from on-chain evidence only:
 *
 *   onchain_event         CreatePoolEvent / CompletePumpAmmMigrationEvent decoded from the pool's own events
 *   instruction_accounts  a PumpSwap swap instruction in a fetched transaction (pool, base_mint, quote_mint
 *                         at the account positions declared by the pinned IDL)
 *   pool_account          getAccountInfo(pool): owner must be the PumpSwap program and the data must start
 *                         with the Pool account discriminator; base/quote mint are read at fixed offsets
 *
 * Third-party hints (DexScreener pair addresses) only trigger a lookup; they are never trusted alone.
 * Disagreeing evidence marks the pool 'conflict'; anything uncertain stays unresolved. Nothing is guessed.
 */
import type Database from 'better-sqlite3';
import { decodeBase58, encodeBase58 } from './base58';
import { BorshReader } from './borsh';
import type { RpcTransaction } from './extract';
import { BudgetExhaustedError } from './helius';
import { PUMP_AMM_PROGRAM_ID, type AmmLayout } from './idl';

export type PoolStatus = 'resolved' | 'unresolved' | 'unresolvable' | 'conflict';
export type PoolMethod = 'onchain_event' | 'instruction_accounts' | 'pool_account';

export interface PoolRow {
  pool: string;
  status: PoolStatus;
  base_mint: string | null;
  quote_mint: string | null;
  method: PoolMethod | null;
  detail: string | null;
  reported_by: string | null;
  attempts: number;
  updated_at: number;
}

export interface AccountInfoLike {
  getAccountInfo(address: string): Promise<{ owner: string; data: [string, string] } | null>;
}

export interface PoolResolverOptions {
  db: Database.Database;
  amm: AmmLayout;
  rpc: AccountInfoLike | null;
  clock: () => number;
  log?: (msg: string) => void;
  /** Max getAccountInfo attempts per pool for retryable failures (default 3). */
  maxAttempts?: number;
  /** Min spacing between attempts for one pool (default 10 min). */
  retryAfterMs?: number;
  /** Called after a pool becomes resolved. */
  onResolved?: (row: PoolRow) => void;
  /** Applied to every stored or logged detail (e.g. API-key redaction). */
  sanitize?: (text: string) => string;
}

export class PoolResolver {
  private queue: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  readonly stats = { lookups: 0, resolved: 0, unresolved: 0, conflicts: 0 };

  constructor(private readonly o: PoolResolverOptions) {}

  get(pool: string): PoolRow | undefined {
    return this.o.db.prepare('SELECT * FROM onchain_pools WHERE pool = ?').get(pool) as PoolRow | undefined;
  }

  resolved(pool: string): { base_mint: string; quote_mint: string | null; method: PoolMethod } | null {
    const r = this.get(pool);
    return r?.status === 'resolved' && r.base_mint ? { base_mint: r.base_mint, quote_mint: r.quote_mint, method: r.method! } : null;
  }

  /** Records on-chain evidence. Agreeing evidence keeps the first method; disagreeing evidence -> conflict. */
  recordEvidence(pool: string, baseMint: string, quoteMint: string | null, method: PoolMethod, detail: string): PoolRow {
    const now = this.o.clock();
    const cur = this.get(pool);
    if (cur?.status === 'conflict') return cur;
    if (cur?.status === 'resolved' && cur.base_mint) {
      const sameBase = cur.base_mint === baseMint;
      const sameQuote = cur.quote_mint === null || quoteMint === null || cur.quote_mint === quoteMint;
      if (sameBase && sameQuote) {
        if (cur.quote_mint === null && quoteMint !== null) {
          this.o.db.prepare('UPDATE onchain_pools SET quote_mint = ?, updated_at = ? WHERE pool = ?').run(quoteMint, now, pool);
        }
        return this.get(pool)!;
      }
      this.stats.conflicts++;
      const why = `conflict: ${cur.method} says base ${cur.base_mint} / quote ${cur.quote_mint}; ${method} says base ${baseMint} / quote ${quoteMint} (${detail})`;
      const safeWhy = (this.o.sanitize ?? ((t: string) => t))(why);
      this.o.db.prepare("UPDATE onchain_pools SET status = 'conflict', base_mint = NULL, quote_mint = NULL, detail = ?, updated_at = ? WHERE pool = ?").run(safeWhy, now, pool);
      this.o.log?.(`pool ${pool}: ${safeWhy}`);
      return this.get(pool)!;
    }
    this.o.db
      .prepare(
        `INSERT INTO onchain_pools (pool, status, base_mint, quote_mint, method, detail, attempts, first_seen_at, updated_at)
         VALUES (?, 'resolved', ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (pool) DO UPDATE SET status = 'resolved', base_mint = excluded.base_mint, quote_mint = excluded.quote_mint,
           method = excluded.method, detail = excluded.detail, updated_at = excluded.updated_at`,
      )
      .run(pool, baseMint, quoteMint, method, detail, now, now);
    this.stats.resolved++;
    const row = this.get(pool)!;
    this.o.onResolved?.(row);
    return row;
  }

  /** Reads pool/base/quote accounts of PumpSwap swap instructions in a fetched transaction. */
  recordFromTransaction(signature: string, tx: RpcTransaction): number {
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    const ixs = [...(tx.transaction.message.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
    let n = 0;
    for (const ix of ixs) {
      if (keys[ix.programIdIndex] !== PUMP_AMM_PROGRAM_ID || !ix.accounts) continue;
      let data: Uint8Array;
      try {
        data = decodeBase58(ix.data);
      } catch {
        continue;
      }
      const spec = this.o.amm.swapInstructions.get(Buffer.from(data.subarray(0, 8)).toString('hex'));
      if (!spec) continue;
      const at = (i: number) => (ix.accounts![i] === undefined ? undefined : keys[ix.accounts![i]!]);
      const pool = at(spec.pool);
      const base = at(spec.baseMint);
      const quote = at(spec.quoteMint);
      if (!pool || !base || !quote) continue;
      this.recordEvidence(pool, base, quote, 'instruction_accounts', `${spec.name} in ${signature}`);
      n++;
    }
    return n;
  }

  /** Marks a third-party hint and queues an on-chain lookup. */
  hint(pool: string, reportedBy: string): void {
    const now = this.o.clock();
    this.o.db
      .prepare(
        `INSERT INTO onchain_pools (pool, status, detail, reported_by, attempts, first_seen_at, updated_at)
         VALUES (?, 'unresolved', 'reported by a third party; not yet verified on-chain', ?, 0, ?, ?)
         ON CONFLICT (pool) DO UPDATE SET reported_by = COALESCE(onchain_pools.reported_by, excluded.reported_by)`,
      )
      .run(pool, reportedBy, now, now);
    this.request(pool);
  }

  /** Queues getAccountInfo for an unresolved pool, respecting attempts and spacing. */
  request(pool: string): void {
    if (!this.o.rpc || this.inFlight.has(pool)) return;
    const cur = this.get(pool);
    if (cur && cur.status !== 'unresolved') return;
    if (cur && cur.attempts >= (this.o.maxAttempts ?? 3)) return;
    if (cur && cur.attempts > 0 && this.o.clock() - cur.updated_at < (this.o.retryAfterMs ?? 600_000)) return;
    this.inFlight.add(pool);
    this.queue = this.queue.then(() => this.lookup(pool)).finally(() => this.inFlight.delete(pool));
  }

  idle(): Promise<void> {
    return this.queue;
  }

  private markUnresolved(pool: string, status: 'unresolved' | 'unresolvable', rawDetail: string, attempted: boolean): void {
    const now = this.o.clock();
    const detail = (this.o.sanitize ?? ((t: string) => t))(rawDetail).slice(0, 1000);
    this.o.db
      .prepare(
        `INSERT INTO onchain_pools (pool, status, detail, attempts, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (pool) DO UPDATE SET status = excluded.status, detail = excluded.detail,
           attempts = onchain_pools.attempts + ?, updated_at = excluded.updated_at`,
      )
      .run(pool, status, detail, attempted ? 1 : 0, now, now, attempted ? 1 : 0);
    this.stats.unresolved++;
  }

  private async lookup(pool: string): Promise<void> {
    if (this.resolved(pool)) return;
    this.stats.lookups++;
    let info: { owner: string; data: [string, string] } | null;
    try {
      info = await this.o.rpc!.getAccountInfo(pool);
    } catch (err) {
      const budget = err instanceof BudgetExhaustedError;
      return this.markUnresolved(pool, 'unresolved', budget ? 'budget reached before lookup' : `lookup failed: ${(err as Error).message}`, !budget);
    }
    if (this.resolved(pool)) return; // resolved by an event while waiting
    if (!info) return this.markUnresolved(pool, 'unresolvable', 'account not found (closed, or not a pool)', true);
    if (info.owner !== PUMP_AMM_PROGRAM_ID) return this.markUnresolved(pool, 'unresolvable', `account owner ${info.owner} is not the PumpSwap program`, true);
    if (info.data[1] !== 'base64') return this.markUnresolved(pool, 'unresolved', `unexpected account encoding ${info.data[1]}`, true);
    const data = Buffer.from(info.data[0], 'base64');
    if (data.subarray(0, 8).toString('hex') !== this.o.amm.poolAccountDiscriminatorHex) {
      return this.markUnresolved(pool, 'unresolvable', 'account data is not a Pool (discriminator mismatch)', true);
    }
    try {
      const r = new BorshReader(data.subarray(8));
      const prefix = this.o.amm.decoder.structFields('Pool').slice(0, 5);
      const v: Record<string, unknown> = {};
      for (const f of prefix) v[f.name] = this.o.amm.decoder.decode(f.type, r, f.name);
      const base = v.base_mint as string;
      const quote = v.quote_mint as string;
      if (base === quote || base === encodeBase58(new Uint8Array(32))) {
        return this.markUnresolved(pool, 'unresolvable', `implausible pool mints base ${base} / quote ${quote}`, true);
      }
      this.recordEvidence(pool, base, quote, 'pool_account', 'getAccountInfo: owner and Pool discriminator verified');
    } catch (err) {
      this.markUnresolved(pool, 'unresolvable', `Pool account decode failed: ${(err as Error).message}`, true);
    }
  }
}
