import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BacktestRequestSchema,
  ConfirmResetSchema,
  EmergencyStopSchema,
  OrderRequestSchema,
  PaginationSchema,
  PortfolioResetSchema,
} from '@spb/shared';
import { HttpError, parseOrThrow } from '../lib/errors';
import { runBacktest } from '../backtest/engine';
import { framesFromObservations, syntheticFrames } from '../backtest/datasets';

export function registerTradingRoutes(api: FastifyInstance) {
  const s = () => api.services;

  // ---------- bot control ----------
  api.post('/bot/start', async () => s().bot.start());
  api.post('/bot/stop', async () => s().bot.stop());
  api.post('/bot/emergency-stop', async (req) => {
    const { reason } = parseOrThrow(EmergencyStopSchema, req.body ?? {}, 'emergency stop request');
    return s().bot.emergencyStop(reason);
  });
  api.post('/bot/reset-kill-switch', async (req) => {
    parseOrThrow(ConfirmResetSchema, req.body, 'reset request (send {"confirm":"RESET"})');
    await s().settings.resetKillSwitch();
    return s().bot.status();
  });

  // ---------- portfolio ----------
  api.get('/portfolio', async () => (await s().portfolio.snapshot()).summary);
  api.get('/portfolio/positions', async () => ({ items: (await s().portfolio.snapshot()).views }));
  api.get('/portfolio/equity', async (req) => {
    const { limit } = parseOrThrow(z.object({ limit: z.coerce.number().int().min(1).max(5000).default(500) }), req.query, 'query');
    return { items: await s().repo.listEquity(limit) };
  });
  api.post('/portfolio/reset', async (req) => {
    const body = parseOrThrow(PortfolioResetSchema, req.body, 'reset request');
    if (s().bot.isRunning()) throw new HttpError(409, 'BOT_RUNNING', 'Stop the bot before resetting the paper account');
    await s().orders.reset(body.startingBalanceSol ?? s().config.startingBalanceSol);
    return (await s().portfolio.snapshot()).summary;
  });

  // ---------- orders & trades ----------
  api.get('/trades', async (req) => {
    const q = parseOrThrow(PaginationSchema, req.query, 'query');
    return s().repo.listOrders({ status: 'FILLED', ...q });
  });
  api.get('/orders', async (req) => {
    const q = parseOrThrow(PaginationSchema.extend({ status: z.enum(['FILLED', 'REJECTED']).optional() }), req.query, 'query');
    return s().repo.listOrders(q);
  });
  api.post('/orders', async (req, reply) => {
    const body = parseOrThrow(OrderRequestSchema, req.body, 'order');
    const { order, replay } = await s().orders.submit({
      clientOrderId: body.clientOrderId,
      mint: body.mint,
      side: body.side,
      type: body.type,
      origin: 'manual',
      sizeSol: body.side === 'BUY' ? body.sizeSol : undefined,
      fraction: body.side === 'SELL' ? body.fraction : undefined,
      limitPriceSol: body.limitPriceSol,
    });
    const status = replay ? 200 : order.status === 'FILLED' ? 201 : 422;
    return reply.status(status).send({ order, replay, simulated: true });
  });

  // ---------- backtest ----------
  api.post('/backtest', async (req) => {
    const body = parseOrThrow(BacktestRequestSchema, req.body ?? {}, 'backtest request');
    const { settings, portfolio, repo, config, market } = s();
    let frames;
    let source: string;
    const recordedSource = body.source ?? market.provider.name;
    if (body.dataset === 'recorded') {
      const obs = await repo.listObservations(recordedSource, config.observationRetentionRows);
      frames = framesFromObservations(obs, config.observationRecordIntervalMs || config.pollIntervalMs);
      const tokens = new Set(obs.map((o) => o.mint)).size;
      const label = recordedSource === 'dexscreener' ? 'REAL DexScreener' : 'MOCK';
      source = `recorded ${label} snapshots: ${obs.length} observations, ${tokens} tokens, ${frames.length} frames`;
      if (frames.length < 10) {
        throw new HttpError(
          422,
          'INSUFFICIENT_DATA',
          `Only ${frames.length} recorded ${recordedSource} frame(s) available (need >= 10). ` +
            'Keep the API running with this provider to record snapshots; no history is fabricated.',
        );
      }
    } else {
      frames = await syntheticFrames(body.seed, body.steps, body.tokenCount);
      source = `mock simulator seed=${body.seed} steps=${body.steps} tokens=${body.tokenCount}`;
    }
    return runBacktest(frames, {
      dataset: body.dataset,
      dataSource: source,
      strategy: settings.getStrategy(),
      risk: settings.getRisk(),
      costs: portfolio.costs,
      startingBalanceSol: body.startingBalanceSol,
      recordedSource: body.dataset === 'recorded' ? recordedSource : undefined,
    });
  });
}
