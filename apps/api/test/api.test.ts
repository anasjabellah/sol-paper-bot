import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PaperOrder, PortfolioSummary, PositionView } from '@spb/shared';
import { type ManualClock, type StaticProvider, cid, makeApp, makeObs, poolObs, testConfig } from './helpers';

let app: FastifyInstance;
let clock: ManualClock;
let provider: StaticProvider;
const MINT = 'mock_0001aaa';

async function setMarket(...obs: ReturnType<typeof makeObs>[]) {
  provider.observations = obs;
  await app.services.market.refresh(true);
}
const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });
const get = (url: string) => app.inject({ method: 'GET', url });
const buy = (sizeSol: number, extra: Record<string, unknown> = {}) =>
  post('/api/orders', { mode: 'PAPER', clientOrderId: cid('buy'), mint: MINT, side: 'BUY', sizeSol, ...extra });
const sell = (fraction: number, extra: Record<string, unknown> = {}) =>
  post('/api/orders', { mode: 'PAPER', clientOrderId: cid('sell'), mint: MINT, side: 'SELL', fraction, ...extra });

beforeEach(async () => {
  ({ app, clock, provider } = (await makeApp()) as { app: FastifyInstance; clock: ManualClock; provider: StaticProvider });
  await setMarket(makeObs(clock.now()));
});
afterEach(async () => {
  await app.close();
});

describe('health & status', () => {
  it('reports paper mode and real trading disabled', async () => {
    const r = await get('/api/health');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mode).toBe('PAPER');
    expect(body.realTradingEnabled).toBe(false);
    expect(body.simulatedMarketData).toBe(true);
    expect(body.database.ok).toBe(true);
    expect(r.headers['x-trading-mode']).toBe('PAPER-SIMULATION-ONLY');
  });

  it('exposes status, provider health and tokens', async () => {
    expect((await get('/api/status')).json().bot.running).toBe(false);
    expect((await get('/api/market/status')).json().state).toBe('ok');
    const tokens = (await get('/api/market/tokens')).json();
    expect(tokens.simulated).toBe(true);
    expect(tokens.items[0].mint).toBe(MINT);
    expect(tokens.items[0].stale).toBe(false);
  });

  it('returns JSON 404s', async () => {
    const r = await get('/api/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('NOT_FOUND');
  });
});

describe('paper order lifecycle', () => {
  it('buys, values and sells with consistent accounting', async () => {
    const r1 = await buy(0.5);
    expect(r1.statusCode).toBe(201);
    const o1 = r1.json().order as PaperOrder;
    expect(o1.status).toBe('FILLED');
    expect(o1.simulated).toBe(true);
    expect(o1.fill!.cashDeltaSol).toBeCloseTo(-(0.5 + 0.005 + 0.000105), 12);

    let summary = (await get('/api/portfolio')).json() as PortfolioSummary;
    expect(summary.cashSol).toBeCloseTo(10 - 0.505105, 12);
    expect(summary.openPositions).toBe(1);
    expect(summary.virtual).toBe(true);
    const positions = (await get('/api/portfolio/positions')).json().items as PositionView[];
    expect(positions[0].costBasisSol).toBeCloseTo(0.505105, 12);
    expect(positions[0].quantity).toBeCloseTo(o1.fill!.quantity, 6);

    // Price rises 20%: pool with same SOL depth, fewer tokens
    clock.advance(20_000);
    await setMarket(poolObs(clock.now(), 1.2e-6));
    const r2 = await sell(1);
    expect(r2.statusCode).toBe(201);
    const o2 = r2.json().order as PaperOrder;
    expect(o2.fill!.realizedPnlSol).toBeCloseTo(o2.fill!.cashDeltaSol - 0.505105, 12);
    expect(o2.fill!.realizedPnlSol!).toBeGreaterThan(0);

    summary = (await get('/api/portfolio')).json();
    expect(summary.openPositions).toBe(0);
    expect(summary.realizedPnlSol).toBeCloseTo(o2.fill!.realizedPnlSol!, 12);
    expect(summary.equitySol).toBeCloseTo(summary.cashSol, 12);
    expect(summary.totalPnlSol).toBeCloseTo(summary.realizedPnlSol, 9);
    expect(summary.feesPaidSol).toBeCloseTo(o1.fill!.tradingFeeSol + o1.fill!.networkFeeSol + o2.fill!.tradingFeeSol + o2.fill!.networkFeeSol, 12);

    const trades = (await get('/api/trades')).json();
    expect(trades.total).toBe(2);
    expect(trades.items[0].side).toBe('SELL');
  });

  it('supports partial sells', async () => {
    await buy(0.5);
    clock.advance(20_000);
    await setMarket(makeObs(clock.now()));
    const o = (await sell(0.25)).json().order as PaperOrder;
    expect(o.status).toBe('FILLED');
    const pos = (await get('/api/portfolio/positions')).json().items[0] as PositionView;
    expect(pos.costBasisSol).toBeCloseTo(0.505105 * 0.75, 9);
  });

  it('rejects overspending', async () => {
    await app.services.settings.updateRisk({ maxOrderSizeSol: 100, maxExposurePerTokenSol: 100 });
    const r = await buy(50);
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/sufficient_balance/);
    expect((await get('/api/portfolio')).json().cashSol).toBe(10);
  });

  it('rejects selling without a position', async () => {
    const r = await sell(1);
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/has_position/);
  });

  it('rejects orders on stale market data', async () => {
    clock.advance(60_000);
    const r = await buy(0.5);
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/price_fresh/);
  });

  it('rejects orders when reserves are unavailable (cannot justify a fill price)', async () => {
    await setMarket(makeObs(clock.now(), { quoteReserveSol: null, baseReserve: null }));
    const r = await buy(0.5);
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/execution_model: pool reserves unavailable/);
  });

  it('rejects unknown tokens', async () => {
    const r = await post('/api/orders', { mode: 'PAPER', clientOrderId: cid(), mint: 'mock_9999zzz', side: 'BUY', sizeSol: 0.1 });
    expect(r.statusCode).toBe(422);
  });

  it('LIMIT orders fill only if the modelled price satisfies the limit (IOC)', async () => {
    const bad = await buy(0.5, { type: 'LIMIT', limitPriceSol: 1e-6 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().order.rejectReason).toMatch(/limit_price/);
    const ok = await buy(0.5, { type: 'LIMIT', limitPriceSol: 1.1e-6 });
    expect(ok.statusCode).toBe(201);
  });

  it('enforces risk limits: max order size, exposure, concurrency', async () => {
    expect((await buy(1.5)).json().order.rejectReason).toMatch(/max_order_size/);
    await app.services.settings.updateRisk({ maxConcurrentPositions: 1, duplicateWindowMs: 0 });
    expect((await buy(0.5)).statusCode).toBe(201);
    expect((await buy(0.6)).json().order.rejectReason).toMatch(/max_exposure_per_token/);
    await setMarket(makeObs(clock.now()), makeObs(clock.now(), { mint: 'mock_0002bbb', symbol: 'SIM-BBB' }));
    const r = await post('/api/orders', { mode: 'PAPER', clientOrderId: cid(), mint: 'mock_0002bbb', side: 'BUY', sizeSol: 0.1 });
    expect(r.json().order.rejectReason).toMatch(/max_concurrent_positions/);
  });

  it('applies post-exit cooldown', async () => {
    await buy(0.3);
    clock.advance(20_000);
    await setMarket(makeObs(clock.now()));
    await sell(1);
    clock.advance(20_000);
    await setMarket(makeObs(clock.now()));
    expect((await buy(0.3)).json().order.rejectReason).toMatch(/cooldown/);
  });
});

describe('duplicate-order prevention', () => {
  it('replays the same clientOrderId idempotently and rejects reuse with different params', async () => {
    const payload = { mode: 'PAPER', clientOrderId: 'idem-000001', mint: MINT, side: 'BUY', sizeSol: 0.5 };
    const r1 = await post('/api/orders', payload);
    const r2 = await post('/api/orders', payload);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().replay).toBe(true);
    expect(r2.json().order.id).toBe(r1.json().order.id);
    expect((await get('/api/trades')).json().total).toBe(1);

    const r3 = await post('/api/orders', { ...payload, sizeSol: 0.6 });
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('blocks same-side orders on a token within the duplicate window', async () => {
    await app.services.settings.updateRisk({ maxExposurePerTokenSol: 5 });
    expect((await buy(0.2)).statusCode).toBe(201);
    const r = await buy(0.2);
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/duplicate_window/);
  });

  it('concurrent identical submissions produce exactly one fill', async () => {
    const payload = { mode: 'PAPER', clientOrderId: 'race-000001', mint: MINT, side: 'BUY', sizeSol: 0.5 };
    const rs = await Promise.all(Array.from({ length: 5 }, () => post('/api/orders', payload)));
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(4);
    expect((await get('/api/portfolio')).json().cashSol).toBeCloseTo(10 - 0.505105, 12);
  });
});

describe('kill switch', () => {
  it('blocks new orders immediately, stops the bot and requires explicit reset', async () => {
    await post('/api/bot/start');
    const ks = await post('/api/bot/emergency-stop', { reason: 'test' });
    expect(ks.statusCode).toBe(200);
    expect(ks.json().running).toBe(false);
    expect(ks.json().killSwitch.active).toBe(true);

    const r = await buy(0.1);
    expect(r.statusCode).toBe(422);
    expect(r.json().order.rejectReason).toMatch(/kill_switch/);

    const start = await post('/api/bot/start');
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toBe('KILL_SWITCH_ACTIVE');

    expect((await post('/api/bot/reset-kill-switch', {})).statusCode).toBe(400);
    const reset = await post('/api/bot/reset-kill-switch', { confirm: 'RESET' });
    expect(reset.json().killSwitch.active).toBe(false);
    expect(reset.json().running).toBe(false);
    expect((await buy(0.1)).statusCode).toBe(201);

    const audit = (await get('/api/logs/audit?level=error')).json().items;
    expect(audit.some((a: { type: string }) => a.type === 'risk.kill_switch_activated')).toBe(true);
  });
});

describe('validation & errors', () => {
  it.each([
    [{ mode: 'LIVE', clientOrderId: 'abcdefgh1', mint: MINT, side: 'BUY', sizeSol: 1 }],
    [{ clientOrderId: 'abcdefgh1', mint: MINT, side: 'BUY', sizeSol: 1 }],
    [{ mode: 'PAPER', clientOrderId: 'abcdefgh1', mint: MINT, side: 'BUY', sizeSol: -1 }],
    [{ mode: 'PAPER', clientOrderId: 'abcdefgh1', mint: MINT, side: 'BUY', sizeSol: 'lots' }],
    [{ mode: 'PAPER', clientOrderId: 'abcdefgh1', mint: MINT, side: 'BUY', sizeSol: 1, privateKey: 'x' }],
    [{ mode: 'PAPER', clientOrderId: 'bad id!', mint: MINT, side: 'BUY', sizeSol: 1 }],
    [{ mode: 'PAPER', clientOrderId: 'abcdefgh1', mint: MINT, side: 'SELL', fraction: 0 }],
    [{ mode: 'PAPER', clientOrderId: 'abcdefgh1', mint: MINT, side: 'HODL' }],
  ])('rejects invalid order payload %#', async (payload) => {
    const r = await post('/api/orders', payload);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(r.json().details)).toBe(true);
  });

  it('rejects malformed JSON', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/orders', payload: '{bad', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
  });

  it('validates config updates (types, ranges, unknown keys, cross-field rules)', async () => {
    const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
    expect((await put('/api/strategy/config', { orderSizeSol: -1 })).statusCode).toBe(400);
    expect((await put('/api/strategy/config', { enableRealTrading: true })).statusCode).toBe(400);
    expect((await put('/api/strategy/config', { minPriceChange5mPct: 80 })).statusCode).toBe(400);
    expect((await put('/api/risk/config', { maxConcurrentPositions: 0 })).statusCode).toBe(400);
    const ok = await put('/api/strategy/config', { orderSizeSol: 0.1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().config.orderSizeSol).toBe(0.1);
  });

  it('validates query parameters', async () => {
    expect((await get('/api/trades?limit=0')).statusCode).toBe(400);
    expect((await get('/api/logs/audit?level=nope')).statusCode).toBe(400);
  });

  it('requires the bot to be stopped and explicit confirmation to reset the account', async () => {
    await buy(0.5);
    expect((await post('/api/portfolio/reset', {})).statusCode).toBe(400);
    await post('/api/bot/start');
    expect((await post('/api/portfolio/reset', { confirm: 'RESET' })).statusCode).toBe(409);
    await post('/api/bot/stop');
    const r = await post('/api/portfolio/reset', { confirm: 'RESET', startingBalanceSol: 5 });
    expect(r.statusCode).toBe(200);
    expect(r.json().cashSol).toBe(5);
    expect(r.json().openPositions).toBe(0);
  });
});

describe('security', () => {
  it('requires a bearer token for mutations when API_AUTH_TOKEN is set', async () => {
    const token = 'x'.repeat(32);
    const secured = await makeApp({ config: testConfig({ API_AUTH_TOKEN: token }) });
    try {
      const noAuth = await secured.app.inject({ method: 'POST', url: '/api/bot/start' });
      expect(noAuth.statusCode).toBe(401);
      const bad = await secured.app.inject({ method: 'POST', url: '/api/bot/start', headers: { authorization: 'Bearer nope' } });
      expect(bad.statusCode).toBe(401);
      const good = await secured.app.inject({ method: 'POST', url: '/api/bot/start', headers: { authorization: `Bearer ${token}` } });
      expect(good.statusCode).toBe(200);
      expect((await secured.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    } finally {
      await secured.app.close();
    }
  });

  it('restricts CORS to configured origins', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost:3000' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const evil = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
