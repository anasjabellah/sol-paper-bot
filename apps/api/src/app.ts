import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config/env';
import { openDb, type Db } from './database/db';
import { migrate } from './database/migrations';
import { Repository } from './database/repository';
import { AuditLogger } from './logging/audit';
import { MockMarketProvider } from './market/mockProvider';
import { DexScreenerProvider } from './market/dexscreenerProvider';
import { MarketDataService } from './market/marketService';
import type { MarketDataProvider } from './market/provider';
import { SettingsService } from './services/settingsService';
import { PortfolioService } from './services/portfolioService';
import { OrderService } from './services/orderService';
import { BotService } from './services/botService';
import { MarketControlService, PROVIDER_KV_KEY, type ProviderFactory } from './services/marketControlService';
import { sourceOfMint, type MarketSource } from '@spb/shared';
import { HttpError } from './lib/errors';
import { systemClock, type Clock } from './lib/util';
import { registerSystemRoutes } from './routes/system';
import { registerTradingRoutes } from './routes/trading';
import { registerLogRoutes } from './routes/logs';

export interface AppServices {
  config: AppConfig;
  db: Db;
  repo: Repository;
  audit: AuditLogger;
  market: MarketDataService;
  settings: SettingsService;
  portfolio: PortfolioService;
  orders: OrderService;
  bot: BotService;
  marketControl: MarketControlService;
  clock: Clock;
  startedAt: number;
  /** Where the active provider choice came from at startup. */
  providerSelectedBy: 'dashboard' | 'env' | 'injected';
}

export interface BuildOptions {
  clock?: Clock;
  provider?: MarketDataProvider;
  /** Builds providers for runtime switching (tests inject offline fakes). */
  providerFactory?: ProviderFactory;
  /** Start the polling scheduler (disabled in tests, which call bot.tick() directly). */
  startScheduler?: boolean;
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    services: AppServices;
  }
}

export function createProvider(config: AppConfig, clock: Clock, name: MarketSource = config.marketProvider): MarketDataProvider {
  if (name === 'dexscreener') {
    return new DexScreenerProvider({ ...config.dexscreener, clock });
  }
  return new MockMarketProvider({ ...config.mock, clock });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(config: AppConfig, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const clock = opts.clock ?? systemClock;
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    bodyLimit: 64 * 1024,
  });

  const db = await openDb(config.databaseUrl);
  await migrate(db);
  const repo = new Repository(db);
  const audit = new AuditLogger(repo, app.log, clock);
  const factory: ProviderFactory = opts.providerFactory ?? ((name) => createProvider(config, clock, name));
  // A provider chosen in the dashboard persists and takes precedence over MARKET_PROVIDER.
  const stored = await repo.getKv<MarketSource>(PROVIDER_KV_KEY);
  const storedValid = stored === 'mock' || stored === 'dexscreener' ? stored : undefined;
  const providerSelectedBy = opts.provider ? 'injected' : storedValid ? 'dashboard' : 'env';
  const provider = opts.provider ?? factory(storedValid ?? config.marketProvider);
  const market = new MarketDataService(provider, repo, audit, clock, {
    pollIntervalMs: config.pollIntervalMs,
    recordEveryMs: config.observationRecordIntervalMs,
  });
  const settings = new SettingsService(repo, audit, clock);
  await settings.load();
  const portfolio = new PortfolioService(repo, market, settings, config.costs, clock, config.startingBalanceSol);
  await portfolio.getAccount();
  const orders = new OrderService(repo, market, portfolio, settings, audit, clock);
  const bot = new BotService(repo, market, portfolio, orders, settings, audit, clock, config.pollIntervalMs, config.observationRetentionRows);
  const marketControl = new MarketControlService(repo, market, bot, audit, factory);

  const foreign = (await repo.listPositions()).filter((p) => sourceOfMint(p.mint) !== provider.name);
  if (foreign.length > 0) {
    await audit.warn('market.foreign_positions', `${foreign.length} open position(s) belong to a different data source than ${provider.name}; they cannot be priced until you switch back`, {
      positions: foreign.map((p) => p.mint),
    });
  }

  app.decorate('services', {
    config,
    db,
    repo,
    audit,
    market,
    settings,
    portfolio,
    orders,
    bot,
    marketControl,
    clock,
    startedAt: clock(),
    providerSelectedBy,
  } satisfies AppServices);

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (curl, tests) send no Origin header.
      if (!origin || config.corsOrigins.includes(origin)) cb(null, true);
      else cb(new HttpError(403, 'CORS_REJECTED', `Origin ${origin} is not allowed`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.addHook('onRequest', async (req) => {
    if (!config.apiAuthToken) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!tokenMatches(req.headers.authorization, config.apiAuthToken)) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('x-trading-mode', 'PAPER-SIMULATION-ONLY');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    const status = e.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: e.code ?? 'BAD_REQUEST', message: e.message });
    }
    req.log.error({ err }, 'unhandled error');
    void audit.error('api.unhandled_error', `Unhandled API error on ${req.method} ${req.url}`, { message: e.message });
    return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` });
  });

  await app.register(
    async (api) => {
      registerSystemRoutes(api);
      registerTradingRoutes(api);
      registerLogRoutes(api);
    },
    // Per-request access logs only at debug/trace; the dashboard polls frequently.
    { prefix: '/api', logLevel: config.logLevel === 'debug' || config.logLevel === 'trace' ? config.logLevel : 'warn' },
  );

  app.addHook('onClose', async () => {
    bot.stopScheduler();
    await db.close();
  });

  await audit.info('app.started', 'API started in PAPER mode (simulation only)', {
    provider: provider.name,
    simulated: provider.simulated,
    providerSelectedBy,
  });
  if (opts.startScheduler) bot.startScheduler();
  return app;
}
