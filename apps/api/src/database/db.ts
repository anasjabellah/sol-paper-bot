import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type pg from 'pg';
import { Mutex } from '../lib/util';

export type SqlParam = string | number | null;

/**
 * Minimal async SQL interface implemented by both SQLite and PostgreSQL.
 * SQL is written with `?` placeholders and a portable dialect subset.
 */
export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private readonly lock = new Mutex();

  constructor(
    private readonly raw: Database.Database,
    private readonly inTx = false,
    lock?: Mutex,
  ) {
    if (lock) this.lock = lock;
  }

  // Outside a transaction every statement takes the lock so it can never be
  // interleaved into another flow's open BEGIN...COMMIT block.
  private guard<T>(fn: () => T): Promise<T> {
    return this.inTx ? Promise.resolve().then(fn) : this.lock.run(async () => fn());
  }

  all<T>(sql: string, params: SqlParam[] = []) {
    return this.guard(() => this.raw.prepare(sql).all(...params) as T[]);
  }
  get<T>(sql: string, params: SqlParam[] = []) {
    return this.guard(() => this.raw.prepare(sql).get(...params) as T | undefined);
  }
  run(sql: string, params: SqlParam[] = []) {
    return this.guard(() => ({ changes: this.raw.prepare(sql).run(...params).changes }));
  }
  exec(sql: string) {
    return this.guard(() => void this.raw.exec(sql));
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.lock.run(async () => {
      const tx = new SqliteDb(this.raw, true, this.lock);
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(tx);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    });
  }
  async close() {
    this.raw.close();
  }
}

/** Convert `?` placeholders to `$1..$n`. Our SQL never contains literal `?`. */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

type Queryable = pg.Pool | pg.PoolClient;

class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  constructor(
    private readonly q: Queryable,
    private readonly pool: pg.Pool,
    private readonly inTx = false,
  ) {}

  async all<T>(sql: string, params: SqlParam[] = []) {
    const r = await this.q.query(toPgPlaceholders(sql), params);
    return r.rows as T[];
  }
  async get<T>(sql: string, params: SqlParam[] = []) {
    return (await this.all<T>(sql, params))[0];
  }
  async run(sql: string, params: SqlParam[] = []) {
    const r = await this.q.query(toPgPlaceholders(sql), params);
    return { changes: r.rowCount ?? 0 };
  }
  async exec(sql: string) {
    await this.q.query(sql);
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresDb(client, this.pool, true));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

/**
 * Open a database from a URL:
 *   sqlite::memory:            in-memory (tests)
 *   sqlite:./data/paper.db     file relative to the process cwd
 *   postgres://user:pass@host:5432/db
 * Drivers are loaded lazily so a PostgreSQL-only setup never loads the native SQLite module.
 */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith('sqlite:')) {
    const target = url.slice('sqlite:'.length);
    let file = ':memory:';
    if (target !== ':memory:') {
      file = resolve(target);
      mkdirSync(dirname(file), { recursive: true });
    }
    const { default: SqliteDatabase } = await import('better-sqlite3');
    const raw = new SqliteDatabase(file);
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    return new SqliteDb(raw);
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: pgLib } = await import('pg');
    // BIGINT (int8) and NUMERIC come back as strings by default; our values fit in doubles.
    pgLib.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
    pgLib.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
    const pool = new pgLib.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 });
    await pool.query('SELECT 1');
    return new PostgresDb(pool, pool);
  }
  throw new Error('Unsupported DATABASE_URL scheme');
}

/** Redact credentials before a database URL is logged or returned by the API. */
export function redactDbUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+)(:[^@/]*)?@/, '//$1:***@');
}
