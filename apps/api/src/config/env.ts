import { z } from 'zod';
import { CostConfigSchema, type CostConfig } from '@spb/shared';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Variable names that indicate someone is trying to wire up a real wallet. */
const FORBIDDEN_KEY_RE = /(PRIVATE_?KEY|SEED_?PHRASE|MNEMONIC|WALLET_?(KEY|SECRET)|KEYPAIR)/i;
/** Variable names that try to enable real trading. */
const REAL_TRADING_RE = /^(ENABLE_)?(REAL|LIVE)_?TRADING(_ENABLED)?$/i;

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),
  API_AUTH_TOKEN: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('sqlite:./data/paper.db'),
  MARKET_PROVIDER: z.enum(['mock', 'dexscreener']).default('mock'),
  MARKET_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(300_000).default(5000),
  MOCK_SEED: z.coerce.number().int().min(0).default(42),
  MOCK_TOKEN_COUNT: z.coerce.number().int().min(1).max(50).default(12),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  DEXSCREENER_BASE_URL: z.string().url().default('https://api.dexscreener.com'),
  DEXSCREENER_DEX_IDS: z.string().default('pumpfun,pumpswap'),
  DEXSCREENER_WATCHLIST: z.string().default(''),
  DEXSCREENER_MAX_TRACKED: z.coerce.number().int().min(1).max(300).default(60),
  DEXSCREENER_DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  DEXSCREENER_SEARCH_QUERIES: z.string().default('pumpfun'),
  DEXSCREENER_MIN_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(10_000),
  OBSERVATION_RECORD_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  OBSERVATION_RETENTION_ROWS: z.coerce.number().int().min(1_000).max(5_000_000).default(200_000),
  PAPER_STARTING_BALANCE_SOL: z.coerce.number().finite().positive().max(1_000_000).default(10),
  PAPER_TRADING_FEE_BPS: z.coerce.number().default(100),
  PAPER_SLIPPAGE_BUFFER_BPS: z.coerce.number().default(50),
  PAPER_NETWORK_FEE_SOL: z.coerce.number().default(0.000105),
});

export interface AppConfig {
  host: string;
  port: number;
  corsOrigins: string[];
  apiAuthToken: string | null;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  databaseUrl: string;
  marketProvider: 'mock' | 'dexscreener';
  pollIntervalMs: number;
  mock: { seed: number; tokenCount: number; failureRate: number };
  dexscreener: {
    baseUrl: string;
    dexIds: string[];
    watchlist: string[];
    maxTracked: number;
    discoveryIntervalMs: number;
    searchQueries: string[];
    minPollIntervalMs: number;
  };
  /** Persist validated observations for 'recorded' backtests every N ms (0 = off). */
  observationRecordIntervalMs: number;
  observationRetentionRows: number;
  startingBalanceSol: number;
  costs: CostConfig;
}

export class ConfigError extends Error {}

/**
 * Refuse to run with anything that looks like wallet credentials or a
 * real-trading switch. This app has no code path that could use them, and their
 * presence suggests a misunderstanding we want to surface loudly.
 */
export function assertNoUnsafeEnv(env: NodeJS.ProcessEnv): void {
  const offending = Object.entries(env)
    .filter(([k, v]) => v !== undefined && v !== '' && (FORBIDDEN_KEY_RE.test(k) || REAL_TRADING_RE.test(k)))
    .map(([k]) => k);
  if (offending.length > 0) {
    throw new ConfigError(
      `Refusing to start: unsupported variables present (${offending.join(', ')}). ` +
        'This is a paper-trading-only application; it never uses private keys, seed phrases or real-trading flags. Remove them.',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  assertNoUnsafeEnv(env);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${msg}`);
  }
  const e = parsed.data;
  const costs = CostConfigSchema.safeParse({
    tradingFeeBps: e.PAPER_TRADING_FEE_BPS,
    slippageBufferBps: e.PAPER_SLIPPAGE_BUFFER_BPS,
    networkFeeSol: e.PAPER_NETWORK_FEE_SOL,
  });
  if (!costs.success) {
    throw new ConfigError(`Invalid PAPER_* cost configuration: ${costs.error.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }

  const apiAuthToken = e.API_AUTH_TOKEN.trim() || null;
  if (!LOOPBACK_HOSTS.has(e.HOST)) {
    if (!apiAuthToken || apiAuthToken.length < 24) {
      throw new ConfigError(
        `Refusing to bind to non-loopback HOST=${e.HOST} without API_AUTH_TOKEN (>= 24 chars). ` +
          'Public exposure is not a supported deployment; see docs/SAFETY.md.',
      );
    }
  }
  if (!/^(sqlite:|postgres(ql)?:\/\/)/.test(e.DATABASE_URL)) {
    throw new ConfigError('DATABASE_URL must start with sqlite: or postgres://');
  }

  return {
    host: e.HOST,
    port: e.PORT,
    corsOrigins: csv(e.CORS_ORIGINS),
    apiAuthToken,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    marketProvider: e.MARKET_PROVIDER,
    pollIntervalMs: e.MARKET_POLL_INTERVAL_MS,
    mock: { seed: e.MOCK_SEED, tokenCount: e.MOCK_TOKEN_COUNT, failureRate: e.MOCK_FAILURE_RATE },
    dexscreener: {
      baseUrl: e.DEXSCREENER_BASE_URL.replace(/\/+$/, ''),
      dexIds: csv(e.DEXSCREENER_DEX_IDS),
      watchlist: csv(e.DEXSCREENER_WATCHLIST),
      maxTracked: e.DEXSCREENER_MAX_TRACKED,
      discoveryIntervalMs: e.DEXSCREENER_DISCOVERY_INTERVAL_MS,
      searchQueries: csv(e.DEXSCREENER_SEARCH_QUERIES).filter((q) => q.length <= 64),
      minPollIntervalMs: e.DEXSCREENER_MIN_POLL_INTERVAL_MS,
    },
    observationRecordIntervalMs: e.OBSERVATION_RECORD_INTERVAL_MS,
    observationRetentionRows: e.OBSERVATION_RETENTION_ROWS,
    startingBalanceSol: e.PAPER_STARTING_BALANCE_SOL,
    costs: costs.data,
  };
}
