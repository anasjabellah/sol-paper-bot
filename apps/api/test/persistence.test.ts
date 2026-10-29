import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ManualClock, StaticProvider, makeApp, makeObs, testConfig } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'spb-persist-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('persistence & restart recovery (SQLite file)', () => {
  it('restores account, positions, orders, config, kill switch and audit log after restart', async () => {
    const config = testConfig({ DATABASE_URL: `sqlite:${join(dir, 'paper.db')}` });
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now())];

    // --- first process
    const first = await makeApp({ config, clock, provider });
    await first.app.services.market.refresh(true);
    const buy = await first.app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { mode: 'PAPER', clientOrderId: 'persist-0001', mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.5 },
    });
    expect(buy.statusCode).toBe(201);
    await first.app.inject({ method: 'PUT', url: '/api/strategy/config', payload: { orderSizeSol: 0.123 } });
    await first.app.inject({ method: 'POST', url: '/api/bot/start' });
    await first.app.inject({ method: 'POST', url: '/api/bot/emergency-stop', payload: { reason: 'before restart' } });
    const before = (await first.app.inject({ method: 'GET', url: '/api/portfolio' })).json();
    await first.app.close();

    // --- second process, same database file
    clock.advance(5_000);
    provider.observations = [makeObs(clock.now())];
    const second = await makeApp({ config, clock, provider });
    await second.app.services.market.refresh(true);
    try {
      const after = (await second.app.inject({ method: 'GET', url: '/api/portfolio' })).json();
      expect(after.cashSol).toBeCloseTo(before.cashSol, 12);
      expect(after.openPositions).toBe(1);
      expect(after.realizedPnlSol).toBe(before.realizedPnlSol);

      const positions = (await second.app.inject({ method: 'GET', url: '/api/portfolio/positions' })).json().items;
      expect(positions[0].mint).toBe('mock_0001aaa');

      // Idempotency survives restarts
      const replay = await second.app.inject({
        method: 'POST',
        url: '/api/orders',
        payload: { mode: 'PAPER', clientOrderId: 'persist-0001', mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.5 },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().replay).toBe(true);

      expect((await second.app.inject({ method: 'GET', url: '/api/strategy/config' })).json().config.orderSizeSol).toBe(0.123);
      const status = (await second.app.inject({ method: 'GET', url: '/api/status' })).json();
      expect(status.bot.killSwitch.active).toBe(true);
      expect(status.bot.running).toBe(false); // always boots stopped
      const audit = (await second.app.inject({ method: 'GET', url: '/api/logs/audit?limit=100' })).json().items;
      expect(audit.some((a: { type: string }) => a.type === 'order.filled')).toBe(true);
    } finally {
      await second.app.close();
    }
  });
});
