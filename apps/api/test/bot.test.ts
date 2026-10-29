import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StrategyDecision } from '@spb/shared';
import { MockMarketProvider } from '../src/market/mockProvider';
import { ManualClock, StaticProvider, makeApp, makeObs, poolObs, testConfig } from './helpers';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('bot integration (static market)', () => {
  it('opens on a valid signal, records the decision, and takes profit', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now())];
    ({ app } = await makeApp({ clock, provider }));
    const { bot } = app.services;

    await bot.start();
    await bot.tick(); // queue BUY (next-bar: no fill yet)
    expect(bot.pendingCount()).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);

    clock.advance(10_000);
    provider.observations = [makeObs(clock.now())];
    await bot.tick(); // fill BUY on newer observation
    let decisions = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=BUY' })).json().items as StrategyDecision[];
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    expect(d.snapshot?.mint).toBe('mock_0001aaa');
    expect(d.strategyChecks.length).toBeGreaterThan(5);
    expect(d.riskChecks.some((c) => c.name === 'kill_switch')).toBe(true);
    expect(d.outcome).toMatch(/filled on next observation/);
    expect(d.orderId).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(1);

    // Same fill-bar observation again: held, no second BUY
    await bot.tick();
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(1);

    // Price +40% => take profit signal, then fill on the following bar
    clock.advance(10_000);
    provider.observations = [poolObs(clock.now(), 1.4e-6)];
    await bot.tick(); // queue SELL
    expect(bot.pendingCount()).toBe(1);
    clock.advance(10_000);
    provider.observations = [poolObs(clock.now(), 1.4e-6)];
    await bot.tick(); // fill SELL
    decisions = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=SELL' })).json().items;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reasons[0]).toMatch(/take_profit/);
    const summary = (await app.inject({ method: 'GET', url: '/api/portfolio' })).json();
    expect(summary.openPositions).toBe(0);
    expect(summary.realizedPnlSol).toBeGreaterThan(0);
  });

  it('does not trade while stopped and records SKIP reasons when running', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now(), { volume5mSol: 0.5 })];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.bot.tick();
    expect((await app.inject({ method: 'GET', url: '/api/logs/decisions' })).json().items).toHaveLength(0);

    await app.services.bot.start();
    await app.services.bot.tick();
    const skips = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=SKIP' })).json().items as StrategyDecision[];
    expect(skips).toHaveLength(1);
    expect(skips[0].reasons.join(' ')).toMatch(/min_volume_5m/);
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);
  });

  it('auto-trips the kill switch on max drawdown', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now())];
    ({ app } = await makeApp({ clock, provider }));
    const { settings, bot } = app.services;
    await settings.updateRisk({ maxOrderSizeSol: 9, maxExposurePerTokenSol: 9, maxDrawdownPct: 10 });
    await settings.updateStrategy({ orderSizeSol: 5, maxPriceImpactPct: 10, stopLossPct: 99 });
    await bot.start();
    await bot.tick(); // queue BUY
    clock.advance(10_000);
    provider.observations = [makeObs(clock.now())];
    await bot.tick(); // fill BUY
    expect((await app.inject({ method: 'GET', url: '/api/portfolio' })).json().openPositions).toBe(1);

    clock.advance(10_000);
    provider.observations = [poolObs(clock.now(), 0.4e-6)];
    await bot.tick();
    const status = bot.status();
    expect(status.killSwitch.active).toBe(true);
    expect(status.killSwitch.reason).toMatch(/drawdown/);
    expect(status.running).toBe(false);
  });

  it('survives provider outages without trading on stale data', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now(), { volume5mSol: 0.1 })];
    ({ app } = await makeApp({ clock, provider }));
    await app.services.bot.start();
    await app.services.bot.tick();
    provider.failWith = new Error('network down');
    provider.observations = [];
    clock.advance(60_000);
    await app.services.bot.tick();
    expect(app.services.market.health().state).not.toBe('ok');
    expect((await app.inject({ method: 'GET', url: '/api/trades' })).json().total).toBe(0);
    const tokens = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json().items;
    expect(tokens[0].stale).toBe(true);
  });
});

describe('bot: insufficient virtual cash', () => {
  it('skips BUY signals it cannot afford instead of creating a rejected order every cycle', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    // 0.2 SOL < 0.25 SOL order + 1% fee + network fee
    ({ app } = await makeApp({ clock, provider, config: testConfig({ PAPER_STARTING_BALANCE_SOL: '0.2' }) }));
    await app.services.bot.start();
    for (let i = 0; i < 12; i++) {
      // A new observation every cycle (new timestamp => a new deterministic clientOrderId each time)
      provider.observations = [makeObs(clock.now())];
      await app.services.bot.tick();
      clock.advance(5_000);
    }
    const orders = (await app.inject({ method: 'GET', url: '/api/orders?limit=100' })).json();
    expect(orders.total).toBe(0);

    const skips = (await app.inject({ method: 'GET', url: '/api/logs/decisions?action=SKIP&limit=100' })).json().items as StrategyDecision[];
    const cashSkips = skips.filter((d) => /insufficient virtual cash/.test(d.outcome));
    expect(cashSkips.length).toBe(1); // logged once, then throttled (60 s) while nothing changes
    expect(cashSkips[0].outcome).toMatch(/needs 0\.2526\d* SOL, virtual cash 0\.2000\d* SOL/);

    const pipe = (await app.inject({ method: 'GET', url: '/api/strategy/pipeline' })).json();
    expect(pipe.lastCycle).toMatchObject({ buySignals: 1, submitted: 0 });
    expect(pipe.lastCycle.suppressed[0]).toMatch(/insufficient virtual cash/);
    expect(pipe.noOrderReason).toMatch(/insufficient virtual cash/);
  });

  it('the risk manager still rejects an unaffordable order submitted directly (second safeguard)', async () => {
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now())];
    ({ app } = await makeApp({ clock, provider, config: testConfig({ PAPER_STARTING_BALANCE_SOL: '0.2' }) }));
    await app.services.market.refresh(true);
    const r = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { mode: 'PAPER', clientOrderId: 'cash-check-0001', mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.25 },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/sufficient_balance/);
  });
});

describe('bot integration (mock simulator)', () => {
  it('runs many ticks end-to-end with consistent accounting', async () => {
    const clock = new ManualClock();
    const provider = new MockMarketProvider({ seed: 3, tokenCount: 12, clock: clock.now });
    ({ app } = await makeApp({ clock, provider }));
    await app.services.bot.start();
    for (let i = 0; i < 400; i++) {
      clock.advance(5_000);
      await app.services.bot.tick();
    }
    const summary = (await app.inject({ method: 'GET', url: '/api/portfolio' })).json();
    const trades = (await app.inject({ method: 'GET', url: '/api/trades?limit=500' })).json();
    const positions = (await app.inject({ method: 'GET', url: '/api/portfolio/positions' })).json().items;

    // Cash must equal starting balance + sum of all cash deltas.
    const cashFromTrades = trades.items.reduce((s: number, o: { fill: { cashDeltaSol: number } }) => s + o.fill.cashDeltaSol, 0);
    expect(summary.cashSol).toBeCloseTo(10 + cashFromTrades, 9);
    const realized = trades.items.reduce((s: number, o: { fill: { realizedPnlSol: number | null } }) => s + (o.fill.realizedPnlSol ?? 0), 0);
    expect(summary.realizedPnlSol).toBeCloseTo(realized, 9);
    expect(summary.cashSol).toBeGreaterThanOrEqual(0);
    // The identity checks above must not pass vacuously: the simulator should generate trades.
    expect(trades.total).toBeGreaterThan(0);
    expect(positions.length).toBeLessThanOrEqual(3);
    // Equity identity
    expect(summary.equitySol).toBeCloseTo(summary.cashSol + summary.positionsValueSol, 9);
    expect((await app.inject({ method: 'GET', url: '/api/portfolio/equity' })).json().items.length).toBeGreaterThan(10);
  });
});
