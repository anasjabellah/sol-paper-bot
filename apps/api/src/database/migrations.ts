import type { Db } from './db';

/**
 * Portable schema (SQLite + PostgreSQL). Rich records are stored as JSON text in
 * `payload` columns; columns that are filtered or sorted on are promoted.
 */
const MIGRATIONS: { version: number; sql: string[] }[] = [
  {
    version: 1,
    sql: [
      `CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL UNIQUE,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        status TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_mint_side ON orders (mint, side, status, created_at)`,
      `CREATE TABLE IF NOT EXISTS positions (
        mint TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        ts BIGINT NOT NULL,
        mint TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_decisions_action ON decisions (action, id)`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        ts BIGINT NOT NULL,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_level ON audit_log (level, id)`,
      `CREATE TABLE IF NOT EXISTS equity_snapshots (
        ts BIGINT PRIMARY KEY,
        equity DOUBLE PRECISION NOT NULL,
        cash DOUBLE PRECISION NOT NULL,
        positions_value DOUBLE PRECISION NOT NULL,
        realized DOUBLE PRECISION NOT NULL,
        unrealized DOUBLE PRECISION NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        observed_at BIGINT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_observations_source_ts ON observations (source, observed_at)`,
    ],
  },
];

export async function migrate(db: Db): Promise<number> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)`);
  const rows = await db.all<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of m.sql) await tx.exec(stmt);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, Date.now()]);
    });
    count++;
  }
  return count;
}
