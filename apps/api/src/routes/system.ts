import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_RISK_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  MarketProviderSelectSchema,
  REAL_TRADING_ENABLED,
  RiskConfigPatchSchema,
  SIMULATION_DISCLAIMER,
  StrategyConfigPatchSchema,
  TRADING_MODE,
  type StrategyPipelineSummary,
  type TokenView,
} from '@spb/shared';
import { redactDbUrl } from '../database/db';
import { isStale } from '../market/marketService';
import { poolFromObservation } from '../paper/accounting';
import { evaluateEntry } from '../strategy/momentumStrategy';
import { parseOrThrow } from '../lib/errors';

export function registerSystemRoutes(api: FastifyInstance) {
  const s = () => api.services;

  api.get('/health', async () => {
    const { db, market, clock, startedAt, config } = s();
    let dbOk = true;
    try {
      await db.get('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    const health = market.health();
    return {
      status: dbOk && health.state !== 'down' ? 'ok' : 'degraded',
      mode: TRADING_MODE,
      realTradingEnabled: REAL_TRADING_ENABLED,
      simulatedMarketData: health.simulated,
      uptimeSec: Math.round((clock() - startedAt) / 1000),
      database: { dialect: db.dialect, ok: dbOk, url: redactDbUrl(config.databaseUrl) },
      marketData: { provider: health.provider, simulated: health.simulated, state: health.state, lastSuccessAt: health.lastSuccessAt },
      version: '0.1.0',
    };
  });

  api.get('/status', async () => {
    const { bot, market, settings, portfolio, providerSelectedBy } = s();
    return {
      disclaimer: SIMULATION_DISCLAIMER,
      mode: TRADING_MODE,
      realTradingEnabled: REAL_TRADING_ENABLED,
      providerSelectedBy,
      bot: bot.status(),
      market: market.health(),
      risk: settings.getRisk(),
      costs: portfolio.costs,
    };
  });

  api.get('/market/status', async () => s().market.health());

  /** Select the READ-ONLY market-data source. Never affects the (fixed) PAPER trading mode. */
  api.put('/market/provider', async (req) => {
    const { provider } = parseOrThrow(MarketProviderSelectSchema, req.body, 'provider selection');
    return s().marketControl.select(provider);
  });

  api.get('/market/recordings', async () => ({
    items: await s().repo.observationStats(),
    recordIntervalMs: s().config.observationRecordIntervalMs,
    retentionRows: s().config.observationRetentionRows,
  }));

  /** Current observations with freshness, tradability and the deterministic entry evaluation. */
  async function tokenViews(): Promise<TokenView[]> {
    const { market, settings, clock, repo, portfolio } = s();
    const now = clock();
    const risk = settings.getRisk();
    const strategy = settings.getStrategy();
    const held = new Set((await repo.listPositions()).map((p) => p.mint));
    const cooldowns = await portfolio.cooldowns();
    return market
      .all()
      .map((o) => {
        const stale = isStale(o, now, risk.maxDataAgeMs);
        const tracked = market.isTracked(o.mint);
        const pool = poolFromObservation(o);
        const blockers: string[] = [];
        if (!pool.ok) blockers.push(pool.reason);
        if (!tracked) blockers.push('no longer refreshed: dropped from the tracked set (discovery churn); last data shown');
        else if (stale) blockers.push('stale data');
        const entry = evaluateEntry(o, {
          now,
          strategy,
          risk,
          costs: portfolio.costs,
          held: held.has(o.mint),
          lastExitAt: cooldowns[o.mint] ?? null,
        });
        return {
          ...o,
          ageMs: now - o.observedAt,
          stale,
          held: held.has(o.mint),
          tradable: blockers.length === 0,
          blockers,
          entrySignal: entry.action === 'BUY' ? ('BUY' as const) : ('SKIP' as const),
          entryFailures: entry.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
          tracked,
          fetchedAt: o.observedAt,
          // Neither provider reports a per-record market timestamp; never substitute pairCreatedAt.
          sourceTimestamp: null,
          lastChangedAt: market.lastChangedAt(o.mint),
        };
      })
      .sort((a, b) => (b.volume5mSol ?? -1) - (a.volume5mSol ?? -1));
  }

  api.get('/market/tokens', async () => {
    const { market } = s();
    return { items: await tokenViews(), simulated: market.provider.simulated, provider: market.provider.name };
  });

  /** Funnel: observed -> tracked -> fresh -> tradable -> entry signal -> order, plus why nothing was ordered. */
  api.get('/strategy/pipeline', async (): Promise<StrategyPipelineSummary> => {
    const { market, bot, clock } = s();
    const items = await tokenViews();
    const firstFailure: Record<string, number> = {};
    for (const t of items) {
      if (t.entrySignal === 'BUY') continue;
      const rule = (t.entryFailures[0] ?? 'unknown').split(':')[0];
      firstFailure[rule] = (firstFailure[rule] ?? 0) + 1;
    }
    const status = bot.status();
    const lastCycle = bot.cycleStats();
    const entrySignals = items.filter((t) => t.entrySignal === 'BUY').length;
    let noOrderReason: string | null = null;
    if (!status.running) noOrderReason = 'The bot is stopped, so no orders are submitted.';
    else if (status.killSwitch.active) noOrderReason = 'The emergency stop is active.';
    else if (lastCycle && lastCycle.filled > 0) noOrderReason = null;
    else if (bot.pendingCount() > 0) noOrderReason = 'A signal is queued for next-observation fill (paper/backtest aligned).';
    else if (lastCycle && lastCycle.suppressed.length) noOrderReason = `BUY signals were suppressed by portfolio limits: ${lastCycle.suppressed.join(' | ')}`;
    else if (lastCycle && lastCycle.rejected.length) noOrderReason = `Orders were submitted but rejected: ${lastCycle.rejected.join(' | ')}`;
    else if (entrySignals === 0) noOrderReason = 'No candidate currently passes every entry rule (see first-failure counts).';
    return {
      at: clock(),
      provider: market.provider.name,
      simulated: market.provider.simulated,
      botRunning: status.running,
      killSwitchActive: status.killSwitch.active,
      buyBlockedReasons: status.buyBlockedReasons,
      observed: items.length,
      tracked: items.filter((t) => t.tracked).length,
      fresh: items.filter((t) => t.tracked && !t.stale).length,
      tradable: items.filter((t) => t.tradable).length,
      entrySignals,
      firstFailure,
      lastCycle,
      noOrderReason,
    };
  });

  api.get('/strategy/config', async () => ({ config: s().settings.getStrategy(), defaults: DEFAULT_STRATEGY_CONFIG }));
  api.put('/strategy/config', async (req) => {
    const patch = parseOrThrow(StrategyConfigPatchSchema, req.body, 'strategy configuration');
    return { config: await s().settings.updateStrategy(patch) };
  });

  api.get('/risk/config', async () => ({ config: s().settings.getRisk(), defaults: DEFAULT_RISK_CONFIG }));
  api.put('/risk/config', async (req) => {
    const patch = parseOrThrow(RiskConfigPatchSchema, req.body, 'risk configuration');
    return { config: await s().settings.updateRisk(patch) };
  });
}
