import { z } from 'zod';
import { ConfigError, type AppConfig } from '../config/env';
import { loadRecorderConfig } from '../recorder/config';
import { isBase58Address } from './base58';
import type { BudgetLimits, CreditModel } from './budget';
import { redact } from './helius';

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Hard upper bound on logsSubscribe subscriptions per connection in this prototype. */
export const MAX_SUBSCRIPTIONS = 50;

const OnchainEnvSchema = z.object({
  HELIUS_API_KEY: z.string().default(''),
  HELIUS_RPC_URL: z.string().url().default('https://mainnet.helius-rpc.com/'),
  HELIUS_WS_URL: z.string().url().default('wss://mainnet.helius-rpc.com/'),
  ONCHAIN_WATCHLIST: z.string().default(''),
  ONCHAIN_DISCOVERY: z.enum(['dexscreener', 'off']).default('dexscreener'),
  ONCHAIN_DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(120_000),
  ONCHAIN_MAX_ACTIVE: z.coerce.number().int().min(1).max(MAX_SUBSCRIPTIONS).default(20),
  ONCHAIN_WATCH_IDLE_MINUTES: z.coerce.number().min(5).max(7 * 24 * 60).default(60),
  ONCHAIN_MIN_WATCH_MINUTES: z.coerce.number().min(1).max(24 * 60).default(15),
  ONCHAIN_RESOLVE_POOLS: z.enum(['true', 'false']).default('true'),
  ONCHAIN_KEEPALIVE_MS: z.coerce.number().int().min(10_000).max(300_000).default(60_000),
  ONCHAIN_STALE_AFTER_MS: z.coerce.number().int().min(30_000).max(590_000).default(150_000),
  ONCHAIN_DAILY_CREDIT_LIMIT: z.coerce.number().int().min(1).max(10_000_000).default(25_000),
  ONCHAIN_MONTHLY_CREDIT_LIMIT: z.coerce.number().int().min(1).max(100_000_000).default(750_000),
  ONCHAIN_DAILY_BYTES_LIMIT_MB: z.coerce.number().min(1).max(100_000).default(300),
  ONCHAIN_CREDITS_PER_RPC_CALL: z.coerce.number().int().min(1).max(1000).default(1),
  ONCHAIN_WS_CREDITS_PER_100KB: z.coerce.number().min(0).max(1000).default(2),
  ONCHAIN_WS_CREDITS_PER_CONNECTION: z.coerce.number().int().min(0).max(1000).default(1),
  ONCHAIN_BACKFILL_MAX_SIGNATURES: z.coerce.number().int().min(0).max(10_000).default(200),
  ONCHAIN_BACKFILL_ON_START: z.enum(['true', 'false']).default('true'),
  ONCHAIN_STORE_RAW: z.enum(['all', 'errors', 'none']).default('all'),
  ONCHAIN_MAX_TX_VERSION: z.coerce.number().int().min(0).max(10).default(1),
  ONCHAIN_RPC_MIN_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(150),
});

export interface OnchainConfig {
  /** False when HELIUS_API_KEY is empty: nothing connects. */
  enabled: boolean;
  apiKey: string;
  rpcUrl: string;
  wsUrl: string;
  dbPath: string;
  tradingDbPath: string | null;
  /** Static mints (never evicted). */
  watchlist: string[];
  discovery: 'dexscreener' | 'off';
  discoveryIntervalMs: number;
  dexscreener: AppConfig['dexscreener'];
  maxActive: number;
  idleEvictMs: number;
  minWatchMs: number;
  resolvePools: boolean;
  keepalive: { intervalMs: number; staleAfterMs: number };
  limits: BudgetLimits;
  model: CreditModel;
  backfillMaxSignatures: number;
  backfillOnStart: boolean;
  storeRaw: 'all' | 'errors' | 'none';
  maxTxVersion: number;
  rpcMinIntervalMs: number;
}

export function loadOnchainConfig(env: NodeJS.ProcessEnv = process.env): OnchainConfig {
  const rec = loadRecorderConfig(env); // also enforces the wallet/private-key env refusal
  if ((env.ONCHAIN_PROGRAM_SUBSCRIPTIONS ?? '').trim() !== '') {
    throw new ConfigError('ONCHAIN_PROGRAM_SUBSCRIPTIONS is no longer supported: program-wide subscriptions are not used (watch mints instead).');
  }
  const parsed = OnchainEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid on-chain recorder configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const watchlist = [...new Set(csv(e.ONCHAIN_WATCHLIST))];
  const bad = watchlist.filter((m) => !isBase58Address(m));
  if (bad.length) throw new ConfigError(`ONCHAIN_WATCHLIST contains invalid addresses: ${bad.join(', ')}`);
  if (watchlist.length > e.ONCHAIN_MAX_ACTIVE) throw new ConfigError(`ONCHAIN_WATCHLIST has ${watchlist.length} mints; ONCHAIN_MAX_ACTIVE is ${e.ONCHAIN_MAX_ACTIVE}`);
  if (e.ONCHAIN_STALE_AFTER_MS <= e.ONCHAIN_KEEPALIVE_MS) throw new ConfigError('ONCHAIN_STALE_AFTER_MS must be greater than ONCHAIN_KEEPALIVE_MS');
  return {
    enabled: e.HELIUS_API_KEY.trim() !== '',
    apiKey: e.HELIUS_API_KEY.trim(),
    rpcUrl: e.HELIUS_RPC_URL,
    wsUrl: e.HELIUS_WS_URL,
    dbPath: rec.dbPath,
    tradingDbPath: rec.tradingDbPath,
    watchlist,
    discovery: e.ONCHAIN_DISCOVERY,
    discoveryIntervalMs: e.ONCHAIN_DISCOVERY_INTERVAL_MS,
    dexscreener: rec.dexscreener,
    maxActive: e.ONCHAIN_MAX_ACTIVE,
    idleEvictMs: Math.round(e.ONCHAIN_WATCH_IDLE_MINUTES * 60_000),
    minWatchMs: Math.round(e.ONCHAIN_MIN_WATCH_MINUTES * 60_000),
    resolvePools: e.ONCHAIN_RESOLVE_POOLS === 'true',
    keepalive: { intervalMs: e.ONCHAIN_KEEPALIVE_MS, staleAfterMs: e.ONCHAIN_STALE_AFTER_MS },
    limits: {
      dailyCredits: e.ONCHAIN_DAILY_CREDIT_LIMIT,
      monthlyCredits: e.ONCHAIN_MONTHLY_CREDIT_LIMIT,
      dailyBytes: Math.round(e.ONCHAIN_DAILY_BYTES_LIMIT_MB * 1024 * 1024),
    },
    model: {
      creditsPerRpcCall: e.ONCHAIN_CREDITS_PER_RPC_CALL,
      wsCreditsPer100Kb: e.ONCHAIN_WS_CREDITS_PER_100KB,
      wsCreditsPerConnection: e.ONCHAIN_WS_CREDITS_PER_CONNECTION,
    },
    backfillMaxSignatures: e.ONCHAIN_BACKFILL_MAX_SIGNATURES,
    backfillOnStart: e.ONCHAIN_BACKFILL_ON_START === 'true',
    storeRaw: e.ONCHAIN_STORE_RAW,
    maxTxVersion: e.ONCHAIN_MAX_TX_VERSION,
    rpcMinIntervalMs: e.ONCHAIN_RPC_MIN_INTERVAL_MS,
  };
}

/** Config for logs and the sessions table: everything except the key. */
export function describeConfig(c: OnchainConfig): Record<string, unknown> {
  const { apiKey: _apiKey, ...rest } = c;
  // URLs may embed a key (?api-key=...) if configured that way; redact them too.
  return { ...rest, rpcUrl: redact(c.rpcUrl, c.apiKey), wsUrl: redact(c.wsUrl, c.apiKey), apiKey: c.apiKey ? '***' : '' };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch {
    return false;
  }
}

/** Every endpoint a recording session would contact (host only; never the key). */
export function networkEndpoints(c: OnchainConfig): { name: string; url: string }[] {
  const out = [
    { name: 'HELIUS_WS_URL', url: c.wsUrl },
    { name: 'HELIUS_RPC_URL', url: c.rpcUrl },
  ];
  if (c.discovery === 'dexscreener') out.push({ name: 'DEXSCREENER_BASE_URL', url: c.dexscreener.baseUrl });
  return out;
}

/** True when running under a test runner, or when network access is explicitly forbidden. */
export function isTestEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST !== undefined || env.NODE_ENV === 'test' || env.ONCHAIN_FORBID_NETWORK === 'true';
}

/**
 * Remote (non-loopback) endpoints need BOTH an explicit --live flag and a non-test environment.
 * Without --live, a session can only talk to a local test server. This holds whatever the API key
 * looks like: a fake key with default URLs is refused, not sent to Helius.
 */
export function assertNetworkAllowed(c: OnchainConfig, opts: { live: boolean; env: NodeJS.ProcessEnv }): void {
  const remote = networkEndpoints(c).filter((e) => !isLoopbackUrl(e.url));
  if (remote.length === 0) return;
  const hosts = remote.map((e) => `${e.name} (${safeHost(e.url)})`).join(', ');
  if (isTestEnvironment(opts.env)) {
    throw new ConfigError(`Refusing remote endpoints in a test environment (VITEST / NODE_ENV=test / ONCHAIN_FORBID_NETWORK): ${hosts}`);
  }
  if (!opts.live) {
    throw new ConfigError(`Refusing remote endpoints without --live: ${hosts}. Use loopback URLs for a local test server, or pass --live to record from the real services.`);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}
