import type {
  AuditEntry,
  AuditLevel,
  EquityPoint,
  MarketObservation,
  PaperOrder,
  Position,
  RecordedSnapshotStats,
  Side,
  StrategyDecision,
} from '@spb/shared';
import { newId } from '../lib/util';
import type { Db } from './db';

type PayloadRow = { payload: string };

/** Data-access layer. Every method accepts an optional transaction handle. */
export class Repository {
  constructor(readonly db: Db) {}

  // ---------- key/value state ----------
  async getKv<T>(key: string, tx: Db = this.db): Promise<T | undefined> {
    const row = await tx.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  async setKv(key: string, value: unknown, tx: Db = this.db): Promise<void> {
    await tx.run(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), Date.now()],
    );
  }

  // ---------- orders ----------
  async insertOrder(o: PaperOrder, tx: Db = this.db): Promise<void> {
    await tx.run(
      'INSERT INTO orders (id, client_order_id, mint, side, status, origin, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [o.id, o.clientOrderId, o.mint, o.side, o.status, o.origin, o.createdAt, JSON.stringify(o)],
    );
  }

  async getOrderByClientId(clientOrderId: string, tx: Db = this.db): Promise<PaperOrder | undefined> {
    const row = await tx.get<PayloadRow>('SELECT payload FROM orders WHERE client_order_id = ?', [clientOrderId]);
    return row ? (JSON.parse(row.payload) as PaperOrder) : undefined;
  }

  async listOrders(opts: { status?: 'FILLED' | 'REJECTED'; limit: number; offset: number }, tx: Db = this.db) {
    const where = opts.status ? 'WHERE status = ?' : '';
    const params = opts.status ? [opts.status, opts.limit, opts.offset] : [opts.limit, opts.offset];
    const rows = await tx.all<PayloadRow>(`SELECT payload FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, params);
    const countRow = await tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders ${where}`, opts.status ? [opts.status] : []);
    return { items: rows.map((r) => JSON.parse(r.payload) as PaperOrder), total: Number(countRow?.n ?? 0) };
  }

  /** Most recent FILLED order timestamp for a mint/side, used for duplicate-order prevention. */
  async lastFilledAt(mint: string, side: Side, tx: Db = this.db): Promise<number | null> {
    const row = await tx.get<{ ts: number | null }>(
      "SELECT MAX(created_at) AS ts FROM orders WHERE mint = ? AND side = ? AND status = 'FILLED'",
      [mint, side],
    );
    return row?.ts != null ? Number(row.ts) : null;
  }

  // ---------- positions ----------
  async listPositions(tx: Db = this.db): Promise<Position[]> {
    const rows = await tx.all<PayloadRow>('SELECT payload FROM positions ORDER BY mint');
    return rows.map((r) => JSON.parse(r.payload) as Position);
  }

  async getPosition(mint: string, tx: Db = this.db): Promise<Position | undefined> {
    const row = await tx.get<PayloadRow>('SELECT payload FROM positions WHERE mint = ?', [mint]);
    return row ? (JSON.parse(row.payload) as Position) : undefined;
  }

  async upsertPosition(p: Position, tx: Db = this.db): Promise<void> {
    await tx.run(
      `INSERT INTO positions (mint, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (mint) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [p.mint, JSON.stringify(p), p.updatedAt],
    );
  }

  async deletePosition(mint: string, tx: Db = this.db): Promise<void> {
    await tx.run('DELETE FROM positions WHERE mint = ?', [mint]);
  }

  // ---------- decisions ----------
  async insertDecision(d: StrategyDecision, tx: Db = this.db): Promise<void> {
    await tx.run('INSERT INTO decisions (id, ts, mint, action, payload) VALUES (?, ?, ?, ?, ?)', [
      d.id,
      d.ts,
      d.mint,
      d.action,
      JSON.stringify(d),
    ]);
  }

  async listDecisions(opts: { action?: string; limit: number; offset: number }): Promise<StrategyDecision[]> {
    const where = opts.action ? 'WHERE action = ?' : '';
    const params = opts.action ? [opts.action, opts.limit, opts.offset] : [opts.limit, opts.offset];
    const rows = await this.db.all<PayloadRow>(`SELECT payload FROM decisions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, params);
    return rows.map((r) => JSON.parse(r.payload) as StrategyDecision);
  }

  // ---------- audit ----------
  async insertAudit(level: AuditLevel, type: string, message: string, data: unknown, ts: number, tx: Db = this.db) {
    const entry: AuditEntry = { id: newId(ts), ts, level, type, message, data: data ?? null };
    await tx.run('INSERT INTO audit_log (id, ts, level, type, message, payload) VALUES (?, ?, ?, ?, ?, ?)', [
      entry.id,
      ts,
      level,
      type,
      message,
      JSON.stringify(entry.data),
    ]);
    return entry;
  }

  async listAudit(opts: { level?: AuditLevel; limit: number; offset: number }): Promise<AuditEntry[]> {
    const where = opts.level ? 'WHERE level = ?' : '';
    const params = opts.level ? [opts.level, opts.limit, opts.offset] : [opts.limit, opts.offset];
    const rows = await this.db.all<{ id: string; ts: number; level: AuditLevel; type: string; message: string; payload: string }>(
      `SELECT id, ts, level, type, message, payload FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map((r) => ({ id: r.id, ts: Number(r.ts), level: r.level, type: r.type, message: r.message, data: JSON.parse(r.payload) }));
  }

  // ---------- equity ----------
  async insertEquity(p: EquityPoint): Promise<void> {
    await this.db.run(
      `INSERT INTO equity_snapshots (ts, equity, cash, positions_value, realized, unrealized) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (ts) DO NOTHING`,
      [p.ts, p.equity, p.cash, p.positionsValue, p.realized, p.unrealized],
    );
  }

  async listEquity(limit: number): Promise<EquityPoint[]> {
    const rows = await this.db.all<{ ts: number; equity: number; cash: number; positions_value: number; realized: number; unrealized: number }>(
      'SELECT ts, equity, cash, positions_value, realized, unrealized FROM equity_snapshots ORDER BY ts DESC LIMIT ?',
      [limit],
    );
    return rows
      .map((r) => ({
        ts: Number(r.ts),
        equity: Number(r.equity),
        cash: Number(r.cash),
        positionsValue: Number(r.positions_value),
        realized: Number(r.realized),
        unrealized: Number(r.unrealized),
      }))
      .reverse();
  }

  // ---------- recorded observations (for backtesting recorded data) ----------
  async insertObservations(obs: MarketObservation[]): Promise<void> {
    if (obs.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const o of obs) {
        await tx.run('INSERT INTO observations (id, mint, observed_at, source, payload) VALUES (?, ?, ?, ?, ?)', [
          newId(o.observedAt),
          o.mint,
          o.observedAt,
          o.source,
          JSON.stringify(o),
        ]);
      }
    });
  }

  async listObservations(source: string, limit: number): Promise<MarketObservation[]> {
    const rows = await this.db.all<PayloadRow>(
      'SELECT payload FROM observations WHERE source = ? ORDER BY observed_at DESC, id DESC LIMIT ?',
      [source, limit],
    );
    return rows.map((r) => JSON.parse(r.payload) as MarketObservation).reverse();
  }

  async observationStats(): Promise<RecordedSnapshotStats[]> {
    const rows = await this.db.all<{ source: string; n: number; tokens: number; first_at: number | null; last_at: number | null }>(
      'SELECT source, COUNT(*) AS n, COUNT(DISTINCT mint) AS tokens, MIN(observed_at) AS first_at, MAX(observed_at) AS last_at FROM observations GROUP BY source',
    );
    return rows.map((r) => ({
      source: r.source as RecordedSnapshotStats['source'],
      observations: Number(r.n),
      tokens: Number(r.tokens),
      firstAt: r.first_at == null ? null : Number(r.first_at),
      lastAt: r.last_at == null ? null : Number(r.last_at),
    }));
  }

  // ---------- maintenance ----------
  /** Keep only the newest `keep` rows of an id-ordered table. */
  async prune(table: 'decisions' | 'audit_log' | 'observations', keep: number): Promise<number> {
    const r = await this.db.run(
      `DELETE FROM ${table} WHERE id < (SELECT id FROM (SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?) AS t)`,
      [keep],
    );
    return r.changes;
  }

  async pruneEquity(keep: number): Promise<number> {
    const r = await this.db.run(
      'DELETE FROM equity_snapshots WHERE ts < (SELECT ts FROM (SELECT ts FROM equity_snapshots ORDER BY ts DESC LIMIT 1 OFFSET ?) AS t)',
      [keep],
    );
    return r.changes;
  }

  /** Wipe paper trading state (orders, positions, equity, decisions). Audit log is retained. */
  async resetTradingState(tx: Db = this.db): Promise<void> {
    await tx.run('DELETE FROM orders');
    await tx.run('DELETE FROM positions');
    await tx.run('DELETE FROM equity_snapshots');
    await tx.run('DELETE FROM decisions');
    await tx.run("DELETE FROM kv WHERE key IN ('account', 'cooldowns')");
  }
}
