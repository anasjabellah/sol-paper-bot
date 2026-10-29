/**
 * Opt-in Helius on-chain event recorder (read-only).
 *
 *   - Live: one WebSocket, `logsSubscribe { mentions: [address] }` per watched mint at 'confirmed'
 *     commitment. Events are decoded from "Program data" log lines. The watched set can change at
 *     runtime (addSubscription / removeSubscription, driven by the watchlist). No program-wide
 *     subscription exists.
 *   - Keepalive: a JSON-RPC 'ping' every keepalive interval (Helius: 10-minute inactivity timer,
 *     "pings every minute" recommended), plus ws.ping() when the socket supports it. A watchdog
 *     treats a connection with no inbound message for staleAfterMs as dead (gap + reconnect).
 *   - Truncated logs: the transaction is fetched with getTransaction (budget permitting) and
 *     decoded from its self-CPI inner instructions.
 *   - Disconnects / budget pauses / downtime between sessions open gaps. A bounded backfill
 *     (getSignaturesForAddress back to the last signature seen, then getTransaction) runs after
 *     resubscribing. A gap is marked 'backfilled_verified' only when the signature listing reached
 *     that last signature and every listed transaction was fetched and fully decoded.
 *   - De-duplication: chain_events UNIQUE (signature, payload_hash, occurrence), plus a
 *     signature check so a transaction seen live is not fetched again.
 *   - Only payloads that match the pinned IDL layout exactly are stored in chain_events; anything
 *     else is quarantined (onchain_quarantine) or recorded as an error, with a diagnostic.
 *   - PumpSwap pool -> mint comes only from on-chain evidence (see pools.ts); otherwise unresolved.
 *   - Coverage: every server-confirmed subscription opens an onchain_subscription_periods row, closed
 *     with an explicit reason on unsubscribe, stop, budget pause, disconnect, stale connection or a
 *     failed resubscribe. last_alive_at (last inbound message) bounds periods that ended by
 *     connection loss; periods left open by a crash are marked 'session_crashed' with ended_at NULL
 *     (unknown) by the next session. A mint with no open period is not covered.
 * It writes only to recordings.db (opened through the guarded openOnchainDb) and never signs,
 * sends or builds transactions.
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { msUntilNextUtcDay, type UsageBudget } from './budget';
import { mergeCandidates, scanInnerInstructions, scanLogs, type MergedCandidate, type RpcTransaction } from './extract';
import { BudgetExhaustedError, redact, type SignatureInfo } from './helius';
import { DECODER_VERSION, type EventDecoder } from './idl';
import { normalizeEvent, quoteAssetOf } from './normalize';
import { PoolResolver, type AccountInfoLike, type PoolRow } from './pools';

export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export interface RpcLike {
  getSignaturesForAddress(address: string, opts: { until?: string; before?: string; limit: number }): Promise<SignatureInfo[]>;
  getTransaction<T>(signature: string, maxSupportedTransactionVersion: number): Promise<T | null>;
  getAccountInfo?: AccountInfoLike['getAccountInfo'];
}

export interface RecorderHooks {
  onSubscribed?: (address: string, at: number) => void;
  onEvent?: (e: { eventType: string; mint: string | null; pool: string | null; at: number }) => void;
  onPoolResolved?: (row: PoolRow) => void;
}

export type Scheduler = (fn: () => void, ms: number) => () => void;
const defaultScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export interface OnchainRecorderOptions {
  db: Database.Database;
  decoder: EventDecoder;
  budget: UsageBudget;
  rpc: RpcLike;
  wsFactory: WsFactory;
  /** Full WebSocket URL including the key. Never logged. */
  wsUrl: string;
  apiKey: string;
  /** Initial watched addresses (mints). */
  subscriptions: string[];
  clock: () => number;
  schedule?: Scheduler;
  random?: () => number;
  log?: (msg: string) => void;
  backfillMaxSignatures: number;
  backfillOnStart: boolean;
  storeRaw: 'all' | 'errors' | 'none';
  maxTxVersion: number;
  backoff?: { baseMs: number; maxMs: number; stableMs: number };
  /** A socket that has not opened after this long is treated as failed (default 30 s). */
  connectTimeoutMs?: number;
  /** Keepalive interval and stale-connection threshold (defaults 60 s / 150 s). */
  keepalive?: { intervalMs: number; staleAfterMs: number };
  /** Resolve unknown PumpSwap pools with getAccountInfo (default true when the RPC supports it). */
  resolvePools?: boolean;
  hooks?: RecorderHooks;
  runConfig: Record<string, unknown>;
}

export type RecorderStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'paused_budget' | 'stopped';

export interface RecorderStats {
  notifications: number;
  duplicateNotifications: number;
  failedTxSkipped: number;
  eventsInserted: number;
  eventsDuplicate: number;
  decodeErrors: number;
  quarantined: number;
  transactionsFetched: number;
  reconnects: number;
  keepalivesSent: number;
  staleReconnects: number;
}

const PROGRAMS_COLUMN_MAX = 200;
/** How often proof of life is persisted to open periods and the session row (bounds crash uncertainty). */
const ALIVE_WRITE_MS = 30_000;
const SEEN_LRU_MAX = 20_000;

export class OnchainRecorder {
  readonly sessionId = randomUUID();
  status: RecorderStatus = 'idle';
  readonly stats: RecorderStats = {
    notifications: 0, duplicateNotifications: 0, failedTxSkipped: 0, eventsInserted: 0,
    eventsDuplicate: 0, decodeErrors: 0, quarantined: 0, transactionsFetched: 0, reconnects: 0,
    keepalivesSent: 0, staleReconnects: 0,
  };
  readonly pools: PoolResolver;

  private ws: WsLike | null = null;
  /** True between this.ws's open event and its end. */
  private wsOpen = false;
  private reqId = 0;
  private readonly subs: Set<string>;
  private readonly pendingReq = new Map<number, string>();
  private readonly subIdToAddress = new Map<number, string>();
  private readonly subscribed = new Set<string>();
  private readonly keepaliveIds = new Set<number>();
  private readonly unsubscribeIds = new Set<number>();
  private keepaliveErrorLogged = false;
  private cancelKeepalive: (() => void) | null = null;
  private dropConnection: ((code: number, reason: string) => void) | null = null;
  private lastInboundAt = 0;
  private lastAliveWrite = 0;
  /** Open onchain_subscription_periods row per address on the current connection. */
  private readonly openPeriods = new Map<string, number>();
  private attempts = 0;
  private liveSince: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private stopping = false;
  private pausing = false;
  private backfillChain: Promise<void> = Promise.resolve();
  private readonly seen = new Set<string>();
  private readonly programIds: Set<string>;
  private readonly schedule: Scheduler;
  private readonly random: () => number;
  private readonly log: (msg: string) => void;
  private readonly backoff: { baseMs: number; maxMs: number; stableMs: number };
  private readonly connectTimeoutMs: number;
  private readonly keepalive: { intervalMs: number; staleAfterMs: number };

  constructor(private readonly o: OnchainRecorderOptions) {
    this.schedule = o.schedule ?? defaultScheduler;
    this.random = o.random ?? Math.random;
    this.log = o.log ?? (() => {});
    this.backoff = o.backoff ?? { baseMs: 1_000, maxMs: 60_000, stableMs: 60_000 };
    this.connectTimeoutMs = o.connectTimeoutMs ?? 30_000;
    this.keepalive = o.keepalive ?? { intervalMs: 60_000, staleAfterMs: 150_000 };
    this.programIds = new Set(o.decoder.eventSpecs().map((s) => s.programId));
    this.subs = new Set(o.subscriptions);
    const canLookup = o.resolvePools !== false && typeof o.rpc.getAccountInfo === 'function';
    this.pools = new PoolResolver({
      db: o.db,
      amm: o.decoder.amm,
      rpc: canLookup ? { getAccountInfo: (a) => o.rpc.getAccountInfo!(a) } : null,
      clock: o.clock,
      log: this.log,
      onResolved: (row) => o.hooks?.onPoolResolved?.(row),
      sanitize: (t) => this.safe(t),
    });
  }

  start(): void {
    const now = this.o.clock();
    // A previous session that never closed was killed or crashed: its end time is unknown.
    this.o.db.transaction(() => {
      this.o.db.prepare("UPDATE onchain_sessions SET stop_reason = 'crashed_or_killed' WHERE stopped_at IS NULL AND stop_reason IS NULL").run();
      this.o.db.prepare("UPDATE onchain_subscription_periods SET end_reason = 'session_crashed' WHERE ended_at IS NULL AND end_reason IS NULL").run();
    })();
    this.o.db
      .prepare('INSERT INTO onchain_sessions (id, started_at, decoder_version, config_json) VALUES (?, ?, ?, ?)')
      .run(this.sessionId, now, DECODER_VERSION, JSON.stringify(this.o.runConfig));
    // Downtime since the previous session is a gap for every address with a cursor.
    for (const address of this.subs) {
      const cur = this.cursor(address);
      if (!cur) continue;
      this.openGap(address, 'between_sessions', cur.updated_at, this.o.backfillOnStart ? null : 'ONCHAIN_BACKFILL_ON_START=false: not backfilled');
    }
    this.connect();
  }

  /** Stops cleanly: closes the socket, waits for running backfills and lookups, closes the session row. */
  async stop(reason = 'stopped'): Promise<void> {
    if (this.status === 'stopped') return;
    this.stopping = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.stopKeepalive();
    this.closePeriods('session_stopped');
    this.ws?.close(1000, 'recorder stopping');
    this.ws = null;
    this.wsOpen = false;
    await this.backfillChain;
    await this.pools.idle();
    const now = this.o.clock();
    this.o.db
      .prepare("UPDATE onchain_gaps SET to_ts = ?, note = COALESCE(note || '; ', '') || 'session stopped during gap' WHERE session_id = ? AND to_ts IS NULL")
      .run(now, this.sessionId);
    this.o.db
      .prepare('UPDATE onchain_sessions SET stopped_at = ?, stop_reason = ?, last_alive_at = MAX(COALESCE(last_alive_at, 0), ?) WHERE id = ?')
      .run(now, reason, this.lastInboundAt, this.sessionId);
    this.status = 'stopped';
    this.log(`stopped (${reason})`);
  }

  /** Resolves when queued backfills and pool lookups have finished (for tests and clean shutdown). */
  async idle(): Promise<void> {
    await this.backfillChain;
    await this.pools.idle();
  }

  // ---------------------------------------------------------------- subscriptions

  /** Currently wanted subscriptions. */
  subscriptions(): string[] {
    return [...this.subs];
  }

  /** Starts watching an address (subscribes immediately when connected). Coverage starts on confirmation. */
  addSubscription(address: string): void {
    if (this.subs.has(address) || this.stopping) return;
    this.subs.add(address);
    if (this.status === 'live') this.status = 'connecting';
    if (this.ws && this.wsOpen) this.sendSubscribe(this.ws, address);
  }

  /**
   * Stops watching an address on purpose: unsubscribes, ends any open gap for it (with a note) and
   * drops its cursor, so a later re-add does not treat the unwatched time as a recoverable gap.
   */
  removeSubscription(address: string): void {
    if (!this.subs.delete(address)) return;
    this.closePeriods('unsubscribed', [address]);
    for (const [subId, a] of [...this.subIdToAddress]) {
      if (a !== address) continue;
      this.subIdToAddress.delete(subId);
      if (this.ws && this.wsOpen) this.sendUnsubscribe(this.ws, subId);
    }
    this.subscribed.delete(address);
    const now = this.o.clock();
    this.o.db
      .prepare("UPDATE onchain_gaps SET to_ts = COALESCE(to_ts, ?), note = COALESCE(note || '; ', '') || 'address unwatched' WHERE subscription = ? AND status = 'open'")
      .run(now, address);
    this.o.db.prepare('DELETE FROM onchain_cursors WHERE subscription = ?').run(address);
    if (this.status !== 'live' && this.ws && this.wsOpen && this.subscribed.size === this.subs.size) this.markLive(now);
  }

  private sendSubscribe(ws: WsLike, address: string): void {
    const id = ++this.reqId;
    this.pendingReq.set(id, address);
    this.send(ws, JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: 'confirmed' }] }));
  }

  private sendUnsubscribe(ws: WsLike, subId: number): void {
    const id = ++this.reqId;
    this.unsubscribeIds.add(id);
    this.send(ws, JSON.stringify({ jsonrpc: '2.0', id, method: 'logsUnsubscribe', params: [subId] }));
  }

  /** Sends and counts outbound bytes against the budget (conservative: Helius may meter only inbound). */
  private send(ws: WsLike, text: string): void {
    ws.send(text);
    const st = this.o.budget.recordWsBytes(Buffer.byteLength(text));
    if (!st.ok) this.pauseForBudget(st.reason, st.scope);
  }

  private markLive(now: number): void {
    this.status = 'live';
    this.liveSince = now;
    this.log(`live: ${this.subscribed.size} subscription(s)`);
  }

  // ---------------------------------------------------------------- connection

  private connect(): void {
    if (this.stopping) return;
    if (!this.o.budget.tryWsConnection()) {
      const st = this.o.budget.check(this.o.budget.model.wsCreditsPerConnection);
      this.pauseForBudget(st.ok ? 'budget reached' : st.reason, st.ok ? 'daily' : st.scope);
      return;
    }
    this.status = this.attempts > 0 ? 'reconnecting' : 'connecting';
    this.pendingReq.clear();
    this.subIdToAddress.clear();
    this.subscribed.clear();
    this.keepaliveIds.clear();
    this.unsubscribeIds.clear();
    let ws: WsLike;
    try {
      ws = this.o.wsFactory(this.o.wsUrl);
    } catch (err) {
      this.error('ws_error', `WebSocket creation failed: ${this.safe(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.wsOpen = false;
    let opened = false;
    let gone = false;
    // Handles the end of this socket exactly once. Node 22's WebSocket can report a failed
    // connection with 'error' only (no 'close'), so both events, the connect timeout and the
    // stale-connection watchdog all lead here.
    const socketGone = (code: number, reason: string) => {
      if (gone) return;
      gone = true;
      cancelConnectTimeout();
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsOpen = false;
      this.dropConnection = null;
      this.stopKeepalive();
      if (this.stopping || this.pausing) return;
      this.error('ws_error', `WebSocket closed (code ${code}${reason ? `: ${this.safe(reason)}` : ''})`);
      this.closePeriods(code === 4002 ? 'stale' : code === 4000 ? 'subscribe_failed' : 'disconnect');
      // Nothing is known after the last message actually received on this connection.
      this.openGapsForAll('disconnect', opened && this.lastInboundAt > 0 ? this.lastInboundAt : this.o.clock());
      if (this.liveSince !== null && this.o.clock() - this.liveSince >= this.backoff.stableMs) this.attempts = 0;
      this.liveSince = null;
      try {
        ws.close(code >= 4000 ? code : 1000, reason);
      } catch {
        // already closed
      }
      this.scheduleReconnect();
    };
    this.dropConnection = socketGone;
    const cancelConnectTimeout = this.schedule(() => {
      if (!opened) socketGone(4001, 'connect timeout');
    }, this.connectTimeoutMs);
    ws.onopen = () => {
      opened = true;
      cancelConnectTimeout();
      if (this.ws !== ws) return;
      this.wsOpen = true;
      this.lastInboundAt = this.o.clock();
      for (const address of this.subs) this.sendSubscribe(ws, address);
      this.startKeepalive(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onerror = (ev) => {
      if (this.ws === ws) this.error('ws_error', `WebSocket error: ${this.safe((ev as { message?: string })?.message ?? 'unknown')}`);
      if (!opened) socketGone(1006, 'connection failed');
    };
    ws.onclose = (ev) => socketGone(ev.code, ev.reason);
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const exp = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempts);
    const delay = Math.round(exp * (0.5 + this.random() * 0.5));
    this.attempts++;
    this.stats.reconnects++;
    this.status = 'reconnecting';
    this.log(`reconnecting in ${delay} ms (attempt ${this.attempts})`);
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.connect();
    }, delay);
  }

  private stopKeepalive(): void {
    this.cancelKeepalive?.();
    this.cancelKeepalive = null;
  }

  private startKeepalive(ws: WsLike): void {
    const tick = () => {
      this.cancelKeepalive = null;
      if (this.ws !== ws || !this.wsOpen) return;
      const silentFor = this.o.clock() - this.lastInboundAt;
      if (silentFor > this.keepalive.staleAfterMs) {
        this.stats.staleReconnects++;
        this.error('ws_error', `No inbound message for ${silentFor} ms (limit ${this.keepalive.staleAfterMs}); treating the connection as stale`);
        this.dropConnection?.(4002, 'stale connection');
        return;
      }
      const id = ++this.reqId;
      this.keepaliveIds.add(id);
      this.stats.keepalivesSent++;
      this.send(ws, JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }));
      const ping = (ws as unknown as { ping?: () => void }).ping;
      if (typeof ping === 'function') {
        try {
          ping.call(ws); // protocol-level ping where the socket implementation supports it
        } catch {
          // optional; the JSON-RPC message above is the keepalive
        }
      }
      if (this.ws === ws && this.wsOpen) this.cancelKeepalive = this.schedule(tick, this.keepalive.intervalMs);
    };
    this.cancelKeepalive = this.schedule(tick, this.keepalive.intervalMs);
  }

  private pauseForBudget(reason: string, scope: 'daily' | 'monthly'): void {
    if (this.pausing || this.stopping) return;
    this.pausing = true;
    this.status = 'paused_budget';
    this.error('budget', `${scope} budget reached: ${reason}. WebSocket closed; no further RPC calls.`);
    this.log(`PAUSED: ${scope} budget reached (${reason})`);
    const ws = this.ws;
    this.ws = null;
    this.wsOpen = false;
    this.dropConnection = null;
    this.stopKeepalive();
    this.closePeriods('budget_pause');
    ws?.close(1000, 'budget reached');
    this.openGapsForAll('budget_pause', this.o.clock());
    this.liveSince = null;
    if (scope === 'monthly') {
      void this.stop('monthly_budget_exhausted');
      return;
    }
    const wait = msUntilNextUtcDay(this.o.clock()) + 5_000;
    this.log(`will resume after the UTC day rolls over (in ${Math.round(wait / 60_000)} min)`);
    this.cancelTimer?.();
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.pausing = false;
      this.attempts = 0;
      this.connect();
    }, wait);
  }

  // ---------------------------------------------------------------- messages

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
    const receivedAt = this.o.clock();
    this.lastInboundAt = receivedAt;
    this.persistAlive(receivedAt);
    const after = this.o.budget.recordWsBytes(Buffer.byteLength(text));
    try {
      this.handleMessage(text, receivedAt);
    } catch (err) {
      this.error('ws_error', `Failed to handle message: ${this.safe(err)}`);
    }
    if (!after.ok) this.pauseForBudget(after.reason, after.scope);
  }

  private handleMessage(text: string, receivedAt: number): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { subscription: number; result: { context: { slot: number }; value: { signature: string; err: unknown; logs: string[] | null } } };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      this.error('ws_error', 'Non-JSON WebSocket message');
      return;
    }
    if (typeof msg.id === 'number' && this.keepaliveIds.delete(msg.id)) {
      if (msg.error && !this.keepaliveErrorLogged) {
        this.keepaliveErrorLogged = true;
        this.log(`keepalive 'ping' answered with an error (${this.safe(msg.error.message)}); traffic still flows both ways and the stale watchdog covers silent drops`);
      }
      return;
    }
    if (typeof msg.id === 'number' && this.unsubscribeIds.delete(msg.id)) return;
    if (typeof msg.id === 'number' && this.pendingReq.has(msg.id)) {
      const address = this.pendingReq.get(msg.id)!;
      this.pendingReq.delete(msg.id);
      if (!this.subs.has(address)) {
        // Removed while the request was in flight: undo the subscription.
        if (typeof msg.result === 'number' && this.ws && this.wsOpen) this.sendUnsubscribe(this.ws, msg.result);
        return;
      }
      if (msg.error || typeof msg.result !== 'number') {
        // Never run with a silently missing subscription: drop the connection and retry with backoff.
        this.error('ws_error', `logsSubscribe failed for ${address}: ${this.safe(msg.error?.message ?? JSON.stringify(msg.result))}; reconnecting`);
        this.dropConnection?.(4000, 'subscription failed');
        return;
      }
      this.subIdToAddress.set(msg.result, address);
      this.onSubscribed(address, receivedAt);
      return;
    }
    if (msg.method === 'logsNotification' && msg.params) {
      const address = this.subIdToAddress.get(msg.params.subscription);
      if (!address) return;
      const { context, value } = msg.params.result;
      this.onNotification(address, value.signature, context.slot, value.err, value.logs ?? [], text, receivedAt);
    }
  }

  private onSubscribed(address: string, now: number): void {
    this.subscribed.add(address);
    if (!this.openPeriods.has(address)) {
      const res = this.o.db
        .prepare('INSERT INTO onchain_subscription_periods (session_id, mint, started_at, last_alive_at) VALUES (?, ?, ?, ?)')
        .run(this.sessionId, address, now, now);
      this.openPeriods.set(address, Number(res.lastInsertRowid));
    }
    this.o.hooks?.onSubscribed?.(address, now);
    const open = this.o.db
      .prepare("SELECT id, kind FROM onchain_gaps WHERE subscription = ? AND to_ts IS NULL AND status = 'open'")
      .all(address) as { id: number; kind: string }[];
    for (const g of open) {
      this.o.db.prepare('UPDATE onchain_gaps SET to_ts = ? WHERE id = ?').run(now, g.id);
      if (g.kind !== 'between_sessions' || this.o.backfillOnStart) this.enqueueBackfill(g.id);
    }
    if (this.status !== 'live' && this.subscribed.size === this.subs.size) this.markLive(now);
  }

  private onNotification(address: string, signature: string, slot: number, err: unknown, logs: string[], text: string, receivedAt: number): void {
    this.stats.notifications++;
    this.updateCursor(address, signature, slot, receivedAt);
    if (this.seen.has(signature)) {
      this.stats.duplicateNotifications++;
      return;
    }
    this.markSeen(signature);
    if (err !== null && err !== undefined) {
      this.stats.failedTxSkipped++; // a failed transaction commits no events
      this.insertRaw('ws_logs', signature, slot, text, receivedAt, true, false);
      return;
    }
    const scan = scanLogs(logs, this.programIds);
    if (scan.truncated) {
      // Logs were cut by the node; inner instructions are complete, so fetch the transaction.
      const rawId = this.insertRaw('ws_logs', signature, slot, text, receivedAt, false, true);
      this.error('log_truncated', 'Logs truncated; fetching transaction for inner-instruction events', { signature, rawId });
      this.backfillChain = this.backfillChain.then(async () => {
        const complete = await this.fetchAndStore(signature);
        if (complete) this.o.db.prepare('UPDATE onchain_raw_messages SET complete = 1 WHERE id = ?').run(rawId);
        // Keep what the truncated logs did contain; the raw message stays marked incomplete.
        else this.storeEvents(signature, slot, null, mergeCandidates(scan.candidates), rawId, receivedAt);
      });
      return;
    }
    // Raw message and its events are written atomically.
    this.o.db.transaction(() => {
      const rawId = this.insertRaw('ws_logs', signature, slot, text, receivedAt, true, scan.problems.length > 0);
      for (const p of scan.problems) this.error('log_problem', p, { signature, rawId });
      this.storeEvents(signature, slot, null, mergeCandidates(scan.candidates), rawId, receivedAt);
    })();
  }

  /** Fetches and stores one transaction. Returns true when its events were fully decoded. */
  private async fetchAndStore(signature: string): Promise<boolean> {
    let tx: RpcTransaction | null;
    try {
      tx = await this.o.rpc.getTransaction<RpcTransaction>(signature, this.o.maxTxVersion);
    } catch (err) {
      this.error(err instanceof BudgetExhaustedError ? 'budget' : 'rpc_error', `getTransaction failed: ${this.safe(err)}`, { signature });
      return false;
    }
    if (!tx) {
      this.error('rpc_error', 'getTransaction returned null (not found at confirmed commitment)', { signature });
      return false;
    }
    this.stats.transactionsFetched++;
    return this.storeTransaction(signature, tx);
  }

  private storeTransaction(signature: string, tx: RpcTransaction): boolean {
    const receivedAt = this.o.clock();
    const text = JSON.stringify(tx);
    if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
      this.insertRaw('rpc_transaction', signature, tx.slot, text, receivedAt, true, false);
      return true;
    }
    if (!tx.meta) {
      this.insertRaw('rpc_transaction', signature, tx.slot, text, receivedAt, false, true);
      this.error('rpc_error', 'Transaction has no meta; events cannot be read', { signature });
      return false;
    }
    const inner = scanInnerInstructions(tx, this.programIds);
    const logs = scanLogs(tx.meta.logMessages ?? [], this.programIds);
    const merged = mergeCandidates(inner.candidates, logs.candidates);
    // Inner instructions are authoritative; truncated logs only matter if there were none.
    const complete = !(logs.truncated && inner.candidates.length === 0);
    const problems = [...inner.problems, ...logs.problems];
    this.markSeen(signature);
    return this.o.db.transaction(() => {
      // Swap instruction accounts give on-chain pool -> mint evidence before the events are stored.
      this.pools.recordFromTransaction(signature, tx);
      const rawId = this.insertRaw('rpc_transaction', signature, tx.slot, text, receivedAt, complete, problems.length > 0 || !complete);
      for (const p of problems) this.error('log_problem', p, { signature, rawId });
      if (!complete) this.error('log_truncated', 'Transaction logs truncated and no inner-instruction events found', { signature, rawId });
      const decodedAll = this.storeEvents(signature, tx.slot, tx.blockTime ?? null, merged, rawId, receivedAt);
      return complete && decodedAll;
    })();
  }

  /** Decodes and inserts events. Returns false if any payload failed to decode. */
  private storeEvents(signature: string, slot: number, blockTime: number | null, merged: MergedCandidate[], rawId: number, receivedAt: number): boolean {
    let allOk = true;
    const insert = this.o.db.prepare(
      `INSERT OR IGNORE INTO chain_events (
        session_id, raw_message_id, signature, slot, block_time, event_index, occurrence, sources, program_id, event_type,
        decode_status, decoder_version, event_time, event_time_raw, received_at, commitment, mint, mint_source, bonding_curve,
        pool, user_address, direction, base_amount, quote_amount, quote_mint, quote_asset, reserve_base_virtual, reserve_quote_virtual,
        reserve_base_real, reserve_quote_real, fees_json, fields_json, missing_fields_json, trailing_bytes, warnings_json,
        payload_hash, payload_b64
      ) VALUES (
        @session_id, @raw_message_id, @signature, @slot, @block_time, @event_index, @occurrence, @sources, @program_id, @event_type,
        @decode_status, @decoder_version, @event_time, @event_time_raw, @received_at, 'confirmed', @mint, @mint_source, @bonding_curve,
        @pool, @user_address, @direction, @base_amount, @quote_amount, @quote_mint, @quote_asset, @reserve_base_virtual, @reserve_quote_virtual,
        @reserve_base_real, @reserve_quote_real, @fees_json, @fields_json, @missing_fields_json, @trailing_bytes, @warnings_json,
        @payload_hash, @payload_b64
      )`,
    );
    const lookups: string[] = [];
    this.o.db.transaction(() => {
      merged.forEach((c, index) => {
        const payloadB64 = Buffer.from(c.payload).toString('base64');
        const d = this.o.decoder.decode(c.programId, c.payload);
        if (d.status === 'error' || d.status === 'unknown_discriminator' || !d.eventName) {
          allOk = false;
          this.stats.decodeErrors++;
          const kind = d.status === 'unknown_discriminator' ? 'unknown_discriminator' : 'decode_error';
          this.error(kind, `${d.eventName ?? d.discriminatorHex}: ${d.error}`, { signature, programId: c.programId, rawId, payloadB64 });
          return;
        }
        if (d.status !== 'ok') {
          // Not an exact match of the pinned layout (unknown trailing bytes, or an older shorter
          // layout): quarantined with a diagnostic, never stored as an accepted event.
          allOk = false;
          this.stats.quarantined++;
          const diagnostic =
            d.status === 'ok_trailing'
              ? `${d.trailingBytes} unknown trailing bytes after all ${d.expectedFields} pinned fields (deployed layout newer than pinned IDL?)`
              : `layout ends after ${d.decodedFields} of ${d.expectedFields} pinned fields; missing ${d.missingFields.join(', ')}`;
          this.o.db
            .prepare(
              `INSERT OR IGNORE INTO onchain_quarantine (session_id, at, signature, slot, program_id, event_type, decode_status, decoder_version, diagnostic, fields_json, payload_hash, payload_b64, raw_message_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(this.sessionId, receivedAt, signature, slot, c.programId, d.eventName, d.status, DECODER_VERSION, diagnostic, JSON.stringify(d.fields), c.payloadHash, payloadB64, rawId);
          this.error('quarantined', `${d.eventName}: ${diagnostic}`, { signature, programId: c.programId, rawId });
          return;
        }
        const n = normalizeEvent(d.eventName, d.fields, receivedAt);
        let mint = n.mint;
        let mintSource: string | null = n.mintSource;
        let quoteMint = n.quoteMint;
        if (n.pool && n.mint && (d.eventName === 'CreatePoolEvent' || d.eventName === 'CompletePumpAmmMigrationEvent')) {
          this.pools.recordEvidence(n.pool, n.mint, n.quoteMint, 'onchain_event', `${d.eventName} in ${signature}`);
        }
        if (n.pool && !mint) {
          const r = this.pools.resolved(n.pool);
          if (r) {
            mint = r.base_mint;
            mintSource = `pool:${r.method}`;
            quoteMint = quoteMint ?? r.quote_mint;
          } else {
            lookups.push(n.pool); // stays unresolved in this row; chain_events_resolved picks it up later
          }
        }
        const res = insert.run({
          session_id: this.sessionId,
          raw_message_id: rawId,
          signature,
          slot,
          block_time: blockTime,
          event_index: index,
          occurrence: c.occurrence,
          sources: [...c.sources].sort().join('+'),
          program_id: c.programId,
          event_type: d.eventName,
          decode_status: d.status,
          decoder_version: DECODER_VERSION,
          event_time: n.eventTimeSec,
          event_time_raw: n.eventTimeRaw,
          received_at: receivedAt,
          mint,
          mint_source: mintSource,
          bonding_curve: n.bondingCurve,
          pool: n.pool,
          user_address: n.user,
          direction: n.direction,
          base_amount: n.baseAmount,
          quote_amount: n.quoteAmount,
          quote_mint: quoteMint,
          quote_asset: quoteAssetOf(quoteMint),
          reserve_base_virtual: n.reserveBaseVirtual,
          reserve_quote_virtual: n.reserveQuoteVirtual,
          reserve_base_real: n.reserveBaseReal,
          reserve_quote_real: n.reserveQuoteReal,
          fees_json: JSON.stringify(n.fees),
          fields_json: JSON.stringify(d.fields),
          missing_fields_json: JSON.stringify(d.missingFields),
          trailing_bytes: d.trailingBytes,
          warnings_json: JSON.stringify(n.warnings),
          payload_hash: c.payloadHash,
          payload_b64: payloadB64,
        });
        if (res.changes > 0) this.stats.eventsInserted++;
        else this.stats.eventsDuplicate++;
        this.o.hooks?.onEvent?.({ eventType: d.eventName, mint, pool: n.pool, at: receivedAt });
      });
    })();
    for (const pool of lookups) this.pools.request(pool);
    return allOk;
  }

  // ---------------------------------------------------------------- gaps and backfill

  private openGapsForAll(kind: 'disconnect' | 'budget_pause', fromTs: number): void {
    for (const address of this.subs) {
      const exists = this.o.db.prepare("SELECT 1 FROM onchain_gaps WHERE subscription = ? AND to_ts IS NULL AND status = 'open'").get(address);
      if (!exists) this.openGap(address, kind, fromTs, null);
    }
  }

  /**
   * Closes open subscription periods (all, or the given addresses). Clean ends (the recorder chose to
   * stop) record the end as observed; lost connections keep last_alive_at at the last inbound message.
   */
  private closePeriods(reason: string, addresses?: string[]): void {
    const now = this.o.clock();
    const targets = addresses ?? [...this.openPeriods.keys()];
    const close = this.o.db.prepare(
      'UPDATE onchain_subscription_periods SET ended_at = ?, end_reason = ?, last_alive_at = MAX(last_alive_at, ?) WHERE id = ? AND ended_at IS NULL AND end_reason IS NULL',
    );
    // last_alive_at only ever moves forward to the last inbound message; onchain_coverage decides
    // (by end_reason) whether coverage extends to ended_at or stops at last_alive_at.
    const alive = this.lastInboundAt;
    this.o.db.transaction(() => {
      for (const a of targets) {
        const id = this.openPeriods.get(a);
        if (id === undefined) continue;
        close.run(now, reason, alive, id);
        this.openPeriods.delete(a);
      }
    })();
  }

  /** Throttled proof of life for open periods and the session (bounds the end of a crashed session). */
  private persistAlive(now: number): void {
    if (now - this.lastAliveWrite < ALIVE_WRITE_MS || this.openPeriods.size === 0) return;
    this.lastAliveWrite = now;
    this.o.db.transaction(() => {
      this.o.db
        .prepare('UPDATE onchain_subscription_periods SET last_alive_at = ? WHERE session_id = ? AND ended_at IS NULL AND end_reason IS NULL')
        .run(now, this.sessionId);
      this.o.db.prepare('UPDATE onchain_sessions SET last_alive_at = ? WHERE id = ?').run(now, this.sessionId);
    })();
  }

  private openGap(address: string, kind: string, fromTs: number, note: string | null): void {
    const cur = this.cursor(address);
    this.o.db
      .prepare('INSERT INTO onchain_gaps (session_id, subscription, kind, from_ts, last_signature, last_slot, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.sessionId, address, kind, fromTs, cur?.last_signature ?? null, cur?.last_slot ?? null, 'open', note);
  }

  private enqueueBackfill(gapId: number): void {
    this.backfillChain = this.backfillChain.then(() => this.backfill(gapId)).catch((err) => this.error('rpc_error', `Backfill crashed: ${this.safe(err)}`));
  }

  private async backfill(gapId: number): Promise<void> {
    if (this.stopping) return;
    const gap = this.o.db.prepare('SELECT * FROM onchain_gaps WHERE id = ?').get(gapId) as { subscription: string; last_signature: string | null };
    const finish = (status: string, note: string, counts: { sigs: number; txs: number; events: number }) => {
      this.o.db
        .prepare(
          "UPDATE onchain_gaps SET status = ?, note = COALESCE(note || '; ', '') || ?, backfill_signatures = ?, backfill_transactions = ?, backfill_events = ?, backfill_at = ? WHERE id = ?",
        )
        .run(status, note, counts.sigs, counts.txs, counts.events, this.o.clock(), gapId);
      this.log(`gap ${gapId} (${gap.subscription}): ${status} - ${note}`);
    };
    const counts = { sigs: 0, txs: 0, events: 0 };
    if (!this.subs.has(gap.subscription)) return finish('open', 'address no longer watched; not backfilled', counts);
    if (!gap.last_signature) return finish('unverifiable', 'no signature seen before the gap; the backfill cannot be bounded', counts);
    const cap = this.o.backfillMaxSignatures;
    if (cap <= 0) return finish('open', 'backfill disabled (ONCHAIN_BACKFILL_MAX_SIGNATURES=0)', counts);

    // 1. List signatures newer than the last one seen, newest first, bounded by `cap`.
    const listed: SignatureInfo[] = [];
    let reachedUntil = false;
    let before: string | undefined;
    try {
      while (listed.length < cap) {
        const limit = Math.min(1000, cap - listed.length);
        const page = await this.o.rpc.getSignaturesForAddress(gap.subscription, { until: gap.last_signature, before, limit });
        listed.push(...page);
        if (page.length < limit) {
          reachedUntil = true;
          break;
        }
        before = page[page.length - 1]!.signature;
      }
    } catch (err) {
      const budget = err instanceof BudgetExhaustedError;
      this.error(budget ? 'budget' : 'rpc_error', `Backfill listing failed: ${this.safe(err)}`);
      return finish(listed.length ? 'backfill_partial' : 'backfill_failed', budget ? 'budget reached while listing' : 'signature listing failed', { ...counts, sigs: listed.length });
    }
    counts.sigs = listed.length;

    // 2. Fetch, oldest first, every successful transaction not already recorded completely.
    const eventsBefore = this.stats.eventsInserted;
    let incomplete = false;
    let stoppedBy: string | null = null;
    for (const s of [...listed].reverse()) {
      if (this.stopping) {
        stoppedBy = 'recorder stopped during backfill';
        break;
      }
      if (s.err !== null && s.err !== undefined) continue;
      if (this.isRecorded(s.signature)) continue;
      let tx: RpcTransaction | null;
      try {
        tx = await this.o.rpc.getTransaction<RpcTransaction>(s.signature, this.o.maxTxVersion);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          stoppedBy = 'budget reached while fetching transactions';
          break;
        }
        this.error('rpc_error', `Backfill getTransaction failed: ${this.safe(err)}`, { signature: s.signature });
        incomplete = true;
        continue;
      }
      if (!tx) {
        this.error('rpc_error', 'Backfill getTransaction returned null', { signature: s.signature });
        incomplete = true;
        continue;
      }
      counts.txs++;
      this.stats.transactionsFetched++;
      if (!this.storeTransaction(s.signature, tx)) incomplete = true;
    }
    counts.events = this.stats.eventsInserted - eventsBefore;

    if (stoppedBy) return finish('backfill_partial', stoppedBy, counts);
    if (!reachedUntil) return finish('backfill_partial', `signature cap ${cap} reached before the last seen signature`, counts);
    if (incomplete) return finish('backfill_partial', 'some transactions could not be fetched or fully decoded', counts);
    return finish('backfilled_verified', 'listing reached the last seen signature; all listed transactions fetched and decoded', counts);
  }

  private isRecorded(signature: string): boolean {
    return !!this.o.db.prepare('SELECT 1 FROM onchain_raw_messages WHERE signature = ? AND complete = 1 LIMIT 1').get(signature);
  }

  // ---------------------------------------------------------------- persistence helpers

  private cursor(address: string): { last_signature: string; last_slot: number; updated_at: number } | undefined {
    return this.o.db.prepare('SELECT last_signature, last_slot, updated_at FROM onchain_cursors WHERE subscription = ?').get(address) as
      | { last_signature: string; last_slot: number; updated_at: number }
      | undefined;
  }

  private updateCursor(address: string, signature: string, slot: number, now: number): void {
    this.o.db
      .prepare(
        `INSERT INTO onchain_cursors (subscription, last_signature, last_slot, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (subscription) DO UPDATE SET last_signature = excluded.last_signature, last_slot = excluded.last_slot, updated_at = excluded.updated_at
         WHERE excluded.last_slot >= onchain_cursors.last_slot`,
      )
      .run(address, signature, slot, now);
  }

  private markSeen(signature: string): void {
    this.seen.add(signature);
    if (this.seen.size > SEEN_LRU_MAX) this.seen.delete(this.seen.values().next().value!);
  }

  private insertRaw(source: string, signature: string, slot: number, text: string, receivedAt: number, complete: boolean, problem: boolean): number {
    const keep = this.o.storeRaw === 'all' || (this.o.storeRaw === 'errors' && (problem || !complete));
    const res = this.o.db
      .prepare('INSERT INTO onchain_raw_messages (session_id, received_at, source, signature, slot, bytes, sha256, complete, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.sessionId, receivedAt, source, signature, slot, Buffer.byteLength(text), createHash('sha256').update(text).digest('hex'), complete ? 1 : 0, keep ? text : null);
    return Number(res.lastInsertRowid);
  }

  private error(kind: string, detail: string, ctx: { signature?: string; programId?: string; rawId?: number; payloadB64?: string } = {}): void {
    const safe = this.safe(detail).slice(0, 2000);
    this.o.db
      .prepare('INSERT INTO onchain_errors (session_id, at, kind, signature, program_id, detail, raw_message_id, payload_b64) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.sessionId, this.o.clock(), kind, ctx.signature ?? null, ctx.programId?.slice(0, PROGRAMS_COLUMN_MAX) ?? null, safe, ctx.rawId ?? null, ctx.payloadB64 ?? null);
    if (kind !== 'log_problem') this.log(`[${kind}] ${safe}`);
  }

  private safe(v: unknown): string {
    return redact(v instanceof Error ? v.message : String(v), this.o.apiKey);
  }
}
