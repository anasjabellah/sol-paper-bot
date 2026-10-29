import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MarketSource, PaperOrder, TokenView } from '@spb/shared';
import { ManualClock, REAL_MINT, StaticProvider, cid, makeApp, makeObs, realObs, testConfig } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'spb-provider-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** App with offline fakes for both providers, so switching never touches the network. */
async function setup(configEnv: Record<string, string> = {}) {
  const clock = new ManualClock();
  const providers: Record<MarketSource, StaticProvider> = { mock: new StaticProvider('mock'), dexscreener: new StaticProvider('dexscreener') };
  providers.mock.observations = [makeObs(clock.now())];
  providers.dexscreener.observations = [
    realObs(clock.now()),
    realObs(clock.now(), { mint: 'FjQYCiHM7VHFw4Syai5YCKZmy4vSPcDWmzNBuC8fpump', symbol: 'Gala', dexId: 'pumpfun', quoteReserveSol: null, baseReserve: null }),
  ];
  const { app } = await makeApp({
    clock,
    config: testConfig(configEnv),
    provider: undefined,
    providerFactory: (name) => providers[name],
  });
  await app.services.market.refresh(true);
  return { app, clock, providers };
}
const put = (app: Awaited<ReturnType<typeof setup>>['app'], provider: unknown) =>
  app.inject({ method: 'PUT', url: '/api/market/provider', payload: { provider } as object });

describe('market provider selection', () => {
  it('starts on the env default and switches to real read-only data', async () => {
    const { app } = await setup();
    try {
      let status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
      expect(status.market.provider).toBe('mock');
      expect(status.providerSelectedBy).toBe('env');

      const r = await put(app, 'dexscreener');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ provider: 'dexscreener', simulated: false });
      await app.services.market.refresh(true);

      const tokens = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json();
      expect(tokens.provider).toBe('dexscreener');
      expect(tokens.simulated).toBe(false);
      expect(tokens.items.every((t: TokenView) => t.source === 'dexscreener' && !t.simulated && !t.mint.startsWith('mock_'))).toBe(true);
      expect(tokens.items.map((t: TokenView) => t.symbol).sort()).toEqual(['Gala', 'N64']);

      status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
      expect(status.mode).toBe('PAPER');
      expect(status.realTradingEnabled).toBe(false);
      const health = (await app.inject({ method: 'GET', url: '/api/health' })).json();
      expect(health.realTradingEnabled).toBe(false);
      expect(health.marketData).toMatchObject({ provider: 'dexscreener', simulated: false });

      const audit = (await app.inject({ method: 'GET', url: '/api/logs/audit?limit=50' })).json().items;
      expect(audit.some((a: { type: string }) => a.type === 'market.provider_changed')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('validates the request strictly', async () => {
    const { app } = await setup();
    try {
      expect((await put(app, 'live')).statusCode).toBe(400);
      expect((await put(app, 'pumpfun')).statusCode).toBe(400);
      const extra = await app.inject({ method: 'PUT', url: '/api/market/provider', payload: { provider: 'dexscreener', realTrading: true } });
      expect(extra.statusCode).toBe(400);
      expect((await put(app, 'mock')).statusCode).toBe(200); // no-op when already active
    } finally {
      await app.close();
    }
  });

  it('refuses to switch while the bot runs or while positions from the other source are open', async () => {
    const { app, clock, providers } = await setup();
    try {
      await app.inject({ method: 'POST', url: '/api/bot/start' });
      const running = await put(app, 'dexscreener');
      expect(running.statusCode).toBe(409);
      expect(running.json().error).toBe('BOT_RUNNING');
      await app.inject({ method: 'POST', url: '/api/bot/stop' });

      const buy = await app.inject({
        method: 'POST',
        url: '/api/orders',
        payload: { mode: 'PAPER', clientOrderId: cid(), mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.2 },
      });
      expect(buy.statusCode).toBe(201);
      const blocked = await put(app, 'dexscreener');
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toBe('POSITIONS_FROM_OTHER_SOURCE');
      expect(blocked.json().details.positions[0].mint).toBe('mock_0001aaa');
      expect(app.services.market.provider.name).toBe('mock');

      // Close the mock position, then switching is allowed
      clock.advance(20_000);
      providers.mock.observations = [makeObs(clock.now())];
      await app.services.market.refresh(true);
      const sell = await app.inject({
        method: 'POST',
        url: '/api/orders',
        payload: { mode: 'PAPER', clientOrderId: cid(), mint: 'mock_0001aaa', side: 'SELL', fraction: 1 },
      });
      expect(sell.statusCode).toBe(201);
      expect((await put(app, 'dexscreener')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('persists the dashboard selection across restarts', async () => {
    const env = { DATABASE_URL: `sqlite:${join(dir, 'provider.db')}` };
    const first = await setup(env);
    expect((await put(first.app, 'dexscreener')).statusCode).toBe(200);
    await first.app.close();
    const second = await setup(env);
    try {
      const status = (await second.app.inject({ method: 'GET', url: '/api/status' })).json();
      expect(status.market.provider).toBe('dexscreener');
      expect(status.providerSelectedBy).toBe('dashboard');
    } finally {
      await second.app.close();
    }
  });
});

describe('paper trading on real-data observations', () => {
  it('fills priceable tokens, labels the data source, and blocks observation-only tokens', async () => {
    const { app } = await setup();
    try {
      await put(app, 'dexscreener');
      await app.services.market.refresh(true);
      const tokens = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json().items as TokenView[];
      const tradable = tokens.find((t) => t.symbol === 'N64')!;
      const curve = tokens.find((t) => t.symbol === 'Gala')!;
      expect(tradable.tradable).toBe(true);
      expect(tradable.blockers).toEqual([]);
      expect(tradable.entrySignal).toBe('BUY');
      expect(curve.tradable).toBe(false);
      expect(curve.quoteReserveSol).toBeNull(); // unavailable, never fabricated
      expect(curve.blockers.join(' ')).toMatch(/reserves unavailable/);
      expect(curve.entrySignal).toBe('SKIP');
      expect(curve.entryFailures.some((f) => f.startsWith('min_liquidity'))).toBe(true);

      const ok = await app.inject({
        method: 'POST',
        url: '/api/orders',
        payload: { mode: 'PAPER', clientOrderId: cid(), mint: REAL_MINT, side: 'BUY', sizeSol: 0.2 },
      });
      expect(ok.statusCode).toBe(201);
      const order = ok.json().order as PaperOrder;
      expect(order.simulated).toBe(true);
      expect(order.marketDataSource).toBe('dexscreener');
      expect(order.fill?.model).toMatch(/AMM/);

      const rejected = await app.inject({
        method: 'POST',
        url: '/api/orders',
        payload: { mode: 'PAPER', clientOrderId: cid(), mint: curve.mint, side: 'BUY', sizeSol: 0.2 },
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().order.rejectReason).toMatch(/execution_model: pool reserves unavailable/);
      expect((await app.inject({ method: 'GET', url: '/api/orders?status=REJECTED' })).json().items[0].marketDataSource).toBe('dexscreener');
    } finally {
      await app.close();
    }
  });

  it('a stale real observation is observation-only and cannot be traded', async () => {
    const { app, clock } = await setup();
    try {
      await put(app, 'dexscreener');
      await app.services.market.refresh(true);
      clock.advance(60_000);
      const t = (await app.inject({ method: 'GET', url: '/api/market/tokens' })).json().items.find((x: TokenView) => x.symbol === 'N64');
      expect(t.stale).toBe(true);
      expect(t.tradable).toBe(false);
      const r = await app.inject({
        method: 'POST',
        url: '/api/orders',
        payload: { mode: 'PAPER', clientOrderId: cid(), mint: REAL_MINT, side: 'BUY', sizeSol: 0.2 },
      });
      expect(r.json().order.rejectReason).toMatch(/price_fresh/);
    } finally {
      await app.close();
    }
  });
});

describe('recorded snapshots & backtests', () => {
  it('refuses to fabricate history and labels real recorded data', async () => {
    const { app, clock } = await setup();
    try {
      const none = await app.inject({ method: 'POST', url: '/api/backtest', payload: { dataset: 'recorded', source: 'dexscreener' } });
      expect(none.statusCode).toBe(422);
      expect(none.json().message).toMatch(/no history is fabricated/);

      const obs = Array.from({ length: 15 }, (_, i) => realObs(clock.now() + i * 60_000));
      await app.services.repo.insertObservations(obs);
      const stats = (await app.inject({ method: 'GET', url: '/api/market/recordings' })).json();
      // Recordings are kept per source: the initial mock poll is recorded separately from real snapshots.
      expect(stats.items.find((x: { source: string }) => x.source === 'dexscreener')).toMatchObject({ observations: 15, tokens: 1 });
      expect(stats.items.find((x: { source: string }) => x.source === 'mock')?.observations).toBe(1);

      const r = await app.inject({ method: 'POST', url: '/api/backtest', payload: { dataset: 'recorded', source: 'dexscreener' } });
      expect(r.statusCode).toBe(200);
      expect(r.json().disclaimer).toMatch(/RECORDED REAL MARKET SNAPSHOTS/);
      expect(r.json().dataSource).toMatch(/REAL DexScreener/);
      expect(r.json().zeroCostNetReturnPct).not.toBeUndefined();

      const synth = await app.inject({ method: 'POST', url: '/api/backtest', payload: { dataset: 'synthetic', steps: 50 } });
      expect(synth.json().disclaimer).toMatch(/SYNTHETIC/);
    } finally {
      await app.close();
    }
  });
});
