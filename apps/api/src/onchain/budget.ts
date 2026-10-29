/**
 * Hard RPC-credit and bandwidth budget, persisted per UTC day in onchain_usage so restarts within
 * the same day keep counting. Credits are an ESTIMATE from a configurable model (Helius pricing as
 * documented at audit time); the Helius dashboard is the authority.
 *
 * RPC calls are checked BEFORE they are made. WebSocket bytes can only be counted on arrival, so
 * the WebSocket is closed as soon as a limit is reached (overshoot is at most one message).
 */
import type Database from 'better-sqlite3';

export interface CreditModel {
  creditsPerRpcCall: number;
  wsCreditsPer100Kb: number;
  wsCreditsPerConnection: number;
}

export interface BudgetLimits {
  dailyCredits: number;
  monthlyCredits: number;
  dailyBytes: number;
}

export interface UsageRow {
  day: string;
  credits: number;
  ws_bytes: number;
  rpc_bytes: number;
  rpc_calls: number;
  ws_connections: number;
}

export type BudgetState = { ok: true } | { ok: false; scope: 'daily' | 'monthly'; reason: string };

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class UsageBudget {
  /** Fractional WebSocket credits not yet persisted as whole credits. */
  private wsCreditRemainder = 0;

  constructor(
    private readonly db: Database.Database,
    readonly limits: BudgetLimits,
    readonly model: CreditModel,
    private readonly clock: () => number,
  ) {}

  today(): UsageRow {
    const day = utcDay(this.clock());
    return (
      (this.db.prepare('SELECT day, credits, ws_bytes, rpc_bytes, rpc_calls, ws_connections FROM onchain_usage WHERE day = ?').get(day) as UsageRow | undefined) ?? {
        day, credits: 0, ws_bytes: 0, rpc_bytes: 0, rpc_calls: 0, ws_connections: 0,
      }
    );
  }

  monthCredits(): number {
    const month = utcDay(this.clock()).slice(0, 7);
    const row = this.db.prepare('SELECT COALESCE(SUM(credits), 0) AS c FROM onchain_usage WHERE substr(day, 1, 7) = ?').get(month) as { c: number };
    return row.c;
  }

  /** Whether `credits` more (and `bytes` more) can be spent without crossing a limit. */
  check(credits = 0, bytes = 0): BudgetState {
    const t = this.today();
    const month = this.monthCredits();
    if (month + credits > this.limits.monthlyCredits) {
      return { ok: false, scope: 'monthly', reason: `monthly credit limit ${this.limits.monthlyCredits} reached (${month} used)` };
    }
    if (t.credits + credits > this.limits.dailyCredits) {
      return { ok: false, scope: 'daily', reason: `daily credit limit ${this.limits.dailyCredits} reached (${t.credits} used)` };
    }
    if (t.ws_bytes + t.rpc_bytes + bytes > this.limits.dailyBytes) {
      return { ok: false, scope: 'daily', reason: `daily bandwidth limit ${this.limits.dailyBytes} bytes reached (${t.ws_bytes + t.rpc_bytes} used)` };
    }
    return { ok: true };
  }

  /** Reserves one RPC call. Returns false (and spends nothing) if it would cross a limit. */
  tryRpcCall(): boolean {
    if (!this.check(this.model.creditsPerRpcCall).ok) return false;
    this.add({ credits: this.model.creditsPerRpcCall, rpc_calls: 1 });
    return true;
  }

  recordRpcBytes(bytes: number): void {
    this.add({ rpc_bytes: bytes });
  }

  tryWsConnection(): boolean {
    if (!this.check(this.model.wsCreditsPerConnection).ok) return false;
    this.add({ credits: this.model.wsCreditsPerConnection, ws_connections: 1 });
    return true;
  }

  /** Counts received WebSocket bytes; returns the budget state afterwards. */
  recordWsBytes(bytes: number): BudgetState {
    this.wsCreditRemainder += (bytes / 102_400) * this.model.wsCreditsPer100Kb;
    const whole = Math.floor(this.wsCreditRemainder);
    this.wsCreditRemainder -= whole;
    this.add({ ws_bytes: bytes, credits: whole });
    return this.check();
  }

  private add(d: Partial<Omit<UsageRow, 'day'>>): void {
    const day = utcDay(this.clock());
    this.db
      .prepare(
        `INSERT INTO onchain_usage (day, credits, ws_bytes, rpc_bytes, rpc_calls, ws_connections, updated_at)
         VALUES (@day, @credits, @ws_bytes, @rpc_bytes, @rpc_calls, @ws_connections, @now)
         ON CONFLICT (day) DO UPDATE SET
           credits = credits + excluded.credits, ws_bytes = ws_bytes + excluded.ws_bytes,
           rpc_bytes = rpc_bytes + excluded.rpc_bytes, rpc_calls = rpc_calls + excluded.rpc_calls,
           ws_connections = ws_connections + excluded.ws_connections, updated_at = excluded.updated_at`,
      )
      .run({
        day,
        credits: d.credits ?? 0,
        ws_bytes: d.ws_bytes ?? 0,
        rpc_bytes: d.rpc_bytes ?? 0,
        rpc_calls: d.rpc_calls ?? 0,
        ws_connections: d.ws_connections ?? 0,
        now: this.clock(),
      });
  }
}

/** Milliseconds until the next UTC midnight (when the daily budget resets). */
export function msUntilNextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}
