import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PaperOrder, StrategyDecision } from '@spb/shared';
import { ManualClock, StaticProvider, makeApp, makeObs, poolObs } from './helpers';

/**
 * Paper bot next-observation fills must match the backtest engine:
 * decide on observation t, fill only after a strictly newer observation.
 */
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('paper next-bar execution (aligned with backtest)', () => {
  it('does not fill on the decision observation; fills only after a newer observation', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    const signalObs = poolObs(clock.now(), 1e-6);
    provider.observations = [signalObs];
    ({ app } = await makeApp({ clock, provider }));
    const { bot } = app.services;

    await bot.start();
    await bot.tick();

    expect(bot.pendingCount()).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/logs/decisions?action=BUY' })).json().items).toHaveLength(0);
    const pipe = (await app.inject({ method: 'GET', url: '/api/strategy/pipeline' })).json();
    expect(pipe.noOrderReason).toMatch(/queued for next-observation fill/);
    expect(pipe.lastCycle).toMatchObject({ buySignals: 1, submitted: 0, filled: 0 });

    // Same observedAt again: still waiting (not a new bar).
    await bot.tick();
    expect(bot.pendingCount()).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);

    // Newer observation at a worse price — fill must use this bar, not the signal price.
    clock.advance(10_000);
    const fillObs = poolObs(clock.now(), 1.1e-6, { priceChange5mPct: 50 });
    provider.observations = [fillObs];
    await bot.tick();

    expect(bot.pendingCount()).toBe(0);
    const trades = (await app.inject({ method: 'GET', url: '/api/trades' })).json().items as PaperOrder[];
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('BUY');
    expect(trades[0].fill!.observationAt).toBe(fillObs.observedAt);
    expect(trades[0].fill!.observationAt).toBeGreaterThan(signalObs.observedAt);
    // Spot on the fill bar is 1.1e-6, not the 1e-6 signal spot.
    expect(trades[0].fill!.spotPriceSol).toBeCloseTo(1.1e-6, 12);
    expect(trades[0].fill!.tradingFeeSol).toBeCloseTo(0.0025, 12);
    expect(trades[0].fill!.networkFeeSol).toBeCloseTo(0.000105, 12);

    const buys = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=BUY' })).json().items as StrategyDecision[];
    expect(buys).toHaveLength(1);
    expect(buys[0].snapshot?.observedAt).toBe(signalObs.observedAt);
    expect(buys[0].outcome).toMatch(/filled on next observation/);
    expect(buys[0].outcome).toContain(String(signalObs.observedAt));
    expect(buys[0].outcome).toContain(String(fillObs.observedAt));
  });

  it('cancels a queued signal when the token is missing from the next snapshot', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now())];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.bot.start();
    await app.services.bot.tick();
    expect(app.services.bot.pendingCount()).toBe(1);

    clock.advance(10_000);
    provider.observations = [];
    await app.services.bot.tick();

    expect(app.services.bot.pendingCount()).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);
    const buys = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=BUY' })).json().items as StrategyDecision[];
    expect(buys).toHaveLength(1);
    expect(buys[0].outcome).toMatch(/cancelled: token absent/);
    expect(buys[0].orderId).toBeNull();
  });

  it('exit signals also fill on the next observation; fees and cash reconcile', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [poolObs(clock.now(), 1e-6)];
    ({ app } = await makeApp({ clock, provider }));
    const { bot } = app.services;
    await bot.start();

    await bot.tick(); // queue BUY
    clock.advance(5_000);
    provider.observations = [poolObs(clock.now(), 1e-6)];
    await bot.tick(); // fill BUY
    expect((await app.inject({ method: 'GET', url: '/api/portfolio' })).json().openPositions).toBe(1);

    clock.advance(5_000);
    provider.observations = [poolObs(clock.now(), 1.4e-6)]; // take-profit signal
    await bot.tick(); // queue SELL
    expect(bot.pendingCount()).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(1);

    clock.advance(5_000);
    const sellFillObs = poolObs(clock.now(), 1.35e-6);
    provider.observations = [sellFillObs];
    await bot.tick(); // fill SELL

    const trades = (await app.inject({ method: 'GET', url: '/api/trades' })).json().items as PaperOrder[];
    const buy = trades.find((t) => t.side === 'BUY')!;
    const sell = trades.find((t) => t.side === 'SELL')!;
    expect(buy).toBeTruthy();
    expect(sell).toBeTruthy();
    expect(sell.fill!.observationAt).toBe(sellFillObs.observedAt);
    const summary = (await app.inject({ method: 'GET', url: '/api/portfolio' })).json();
    const cashFromTrades = trades.reduce((s, o) => s + (o.fill?.cashDeltaSol ?? 0), 0);
    expect(summary.cashSol).toBeCloseTo(10 + cashFromTrades, 9);
    expect(summary.feesPaidSol).toBeCloseTo(
      trades.reduce((s, o) => s + (o.fill?.tradingFeeSol ?? 0) + (o.fill?.networkFeeSol ?? 0), 0),
      9,
    );
    expect(summary.openPositions).toBe(0);
    expect(summary.realizedPnlSol).toBeGreaterThan(0);
  });

  it('stopping the bot cancels queued BUYs but does not invent fills', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now())];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.bot.start();
    await app.services.bot.tick();
    expect(app.services.bot.pendingCount()).toBe(1);

    await app.services.bot.stop('test stop');
    expect(app.services.bot.pendingCount()).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);
    const buys = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=BUY' })).json().items as StrategyDecision[];
    expect(buys.some((d) => /queued BUY cancelled/.test(d.outcome))).toBe(true);
  });
});
