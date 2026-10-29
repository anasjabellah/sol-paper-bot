import { describe, expect, it } from 'vitest';
import { ManualClock, StaticProvider, makeApp, makeObs, testConfig } from './helpers';

/**
 * Runs only when TEST_DATABASE_URL points at a disposable PostgreSQL database, e.g.
 *   docker compose up -d postgres
 *   $env:TEST_DATABASE_URL="postgres://paperbot:paperbot@127.0.0.1:5432/paperbot_test"; npm run test:pg
 * WARNING: the test wipes trading tables in that database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PostgreSQL backend', () => {
  it('migrates, trades, and recovers state across restarts', async () => {
    const config = testConfig({ DATABASE_URL: url! });
    const clock = new ManualClock();
    const provider = new StaticProvider();
    provider.observations = [makeObs(clock.now())];

    const first = await makeApp({ config, clock, provider });
    await first.app.services.orders.reset(10);
    await first.app.services.settings.resetKillSwitch();
    await first.app.services.market.refresh(true);
    const id = `pg-${Date.now()}`;
    const r = await first.app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { mode: 'PAPER', clientOrderId: id, mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.5 },
    });
    expect(r.statusCode).toBe(201);
    const dup = await Promise.all(
      Array.from({ length: 4 }, () =>
        first.app.inject({
          method: 'POST',
          url: '/api/orders',
          payload: { mode: 'PAPER', clientOrderId: id, mint: 'mock_0001aaa', side: 'BUY', sizeSol: 0.5 },
        }),
      ),
    );
    expect(dup.every((d) => d.statusCode === 200)).toBe(true);
    await first.app.close();

    const second = await makeApp({ config, clock, provider });
    try {
      const s = (await second.app.inject({ method: 'GET', url: '/api/portfolio' })).json();
      expect(s.openPositions).toBe(1);
      expect(s.cashSol).toBeCloseTo(10 - 0.505105, 9);
      const health = (await second.app.inject({ method: 'GET', url: '/api/health' })).json();
      expect(health.database.dialect).toBe('postgres');
      expect(health.database.url).not.toMatch(/paperbot:paperbot@/);
    } finally {
      await second.app.close();
    }
  });
});
