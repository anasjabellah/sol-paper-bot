import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError, loadConfig, type AppConfig } from '../config/env';

/** Minimum spacing between pair-data polls (matches the provider's own minimum). */
export const MIN_RECORDER_INTERVAL_MS = 10_000;

const RecorderEnvSchema = z.object({
  RECORDER_DATABASE_URL: z.string().default('sqlite:./data/recordings.db'),
  RECORDER_POLL_INTERVAL_MS: z.coerce.number().int().min(MIN_RECORDER_INTERVAL_MS).max(300_000).default(15_000),
  RECORDER_MAX_TRACKED: z.coerce.number().int().min(1).max(300).default(90),
  RECORDER_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RECORDER_MAX_DB_MB: z.coerce.number().int().min(10).max(1_000_000).default(2048),
});

export interface RecorderConfig {
  /** Absolute path of the recorder's own SQLite file. */
  dbPath: string;
  /** Absolute path of the paper-trading SQLite database (null if trading uses PostgreSQL). */
  tradingDbPath: string | null;
  intervalMs: number;
  maxTracked: number;
  retentionDays: number;
  maxDbMb: number;
  dexscreener: AppConfig['dexscreener'];
}

/** Path of a `sqlite:` URL, or null for non-SQLite / in-memory URLs. */
export function sqlitePathFromUrl(url: string): string | null {
  if (!url.startsWith('sqlite:')) return null;
  const target = url.slice('sqlite:'.length);
  return target === ':memory:' ? null : resolve(target);
}

/**
 * Recorder configuration. Reuses the app's env validation (including the refusal to run with
 * wallet/private-key variables) and its DEXSCREENER_* settings; MARKET_PROVIDER is ignored:
 * the recorder only ever records real, read-only DexScreener data.
 */
export function loadRecorderConfig(env: NodeJS.ProcessEnv = process.env): RecorderConfig {
  const app = loadConfig(env);
  const parsed = RecorderEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid recorder configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const dbPath = sqlitePathFromUrl(e.RECORDER_DATABASE_URL);
  if (!dbPath) throw new ConfigError('RECORDER_DATABASE_URL must be a file-based sqlite: URL (e.g. sqlite:./data/recordings.db)');
  return {
    dbPath,
    tradingDbPath: sqlitePathFromUrl(app.databaseUrl),
    intervalMs: e.RECORDER_POLL_INTERVAL_MS,
    maxTracked: e.RECORDER_MAX_TRACKED,
    retentionDays: e.RECORDER_RETENTION_DAYS,
    maxDbMb: e.RECORDER_MAX_DB_MB,
    dexscreener: app.dexscreener,
  };
}
