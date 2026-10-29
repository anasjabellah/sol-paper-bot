import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PaperOrder, PortfolioSummary, PositionView, StrategyDecision, TokenView } from '@spb/shared';
import { MockMarketProvider } from '../src/market/mockProvider';
import { ManualClock, makeApp, testConfig } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'spb-mock-restart-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = <T>(a: FastifyInstance, url: string) => a.inject({ method: 'GET', url }).then((r) => r.json() as T);

describe('mock simulation run identity', () => {
  it('two runs with the same seed but different start times share no token identities', async () => {
    const t0 = Date.UTC(2026, 5, 1, 12);
    const a = new MockMarketProvider({ seed: 42, tokenCount: 12, clock: () => t0 });
    const b = new MockMarketProvider({ seed: 42, tokenCount: 12, clock: () => t0 + 3_600_000 });
    const mintsA = new Set(((await a.poll()).observations as { mint: string }[]).map((o) => o.mint));
    const mintsB = ((await b.poll()).observations as { mint: string }[]).map((o) => o.mint);
    expect(a.runId).not.toBe(b.runId);
    expect(mintsB.filter((m) => mintsA.has(m))).toEqual([]);
    for (const m of mintsB) expect(m).toMatch(new RegExp(`^mock_${b.runId}_\\d{4}[a-z]{3}$`));
  });

  it('the same start time still reproduces the same run exactly (determinism kept)', async () => {
    const t0 = Date.UTC(2026, 5, 1, 12);
    const a = new MockMarketProvider({ seed: 42, tokenCount: 5, clock: () => t0 });
    const b = new MockMarketProvider({ seed: 42, tokenCount: 5, clock: () => t0 });
    expect((await a.poll()).observations).toEqual((await b.poll()).observations);
  });

  it('legacy pre-fix mints (e.g. mock_0006wmv, mock_0013lld) can never be observed by a new run', async () => {
    const p = new MockMarketProvider({ seed: 42, tokenCount: 12, clock: () => Date.now() });
    const clock = { t: Date.now() };
    const mints = ((await p.poll()).observations as { mint: string }[]).map((o) => o.mint);
    // Advance far enough for dead tokens to be recycled (new ids are issued) and check again.
    const q = new MockMarketProvider({ seed: 42, tokenCount: 12, clock: () => (clock.t += 5_000) });
    for (let i = 0; i < 720; i++) mints.push(...((await q.poll()).observations as { mint: string }[]).map((o) => o.mint));
    expect(mints).not.toContain('mock_0006wmv');
    expect(mints).not.toContain('mock_0013lld');
    expect(mints.every((m) => /^mock_[0-9a-z]+_\d{4}[a-z]{3}$/.test(m))).toBe(true);
  });
});

describe('API restart with an open MOCK position', () => {
  it('a new mock run cannot reprice the old position, fake a drawdown, trip the kill switch or trigger a SELL', async () => {
    const config = testConfig({ DATABASE_URL: `sqlite:${join(dir, 'restart.db')}` });
    const clock = new ManualClock(Date.UTC(2026, 5, 1, 12));

    // ---- run 1: open a position on a mock token ----
    const run1 = new MockMarketProvider({ seed: 42, tokenCount: 12, clock: clock.now });
    ({ app } = await makeApp({ clock, provider: run1, config }));
    await app.services.market.refresh(true);
    const token = (await get<{ items: TokenView[] }>(app, '/api/market/tokens')).items.find((t) => t.tradable)!;
    const buy = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { mode: 'PAPER', clientOrderId: 'restart-buy-0001', mint: token.mint, side: 'BUY', sizeSol: 0.25 },
    });
    expect(buy.statusCode).toBe(201);
    await app.services.bot.tick(); // mark to market + peak equity on run-1 prices
    const before = await get<PortfolioSummary>(app, '/api/portfolio');
    const posBefore = (await get<{ items: PositionView[] }>(app, '/api/portfolio/positions')).items[0];
    expect(posBefore.valuationMethod).toBe('amm-liquidation');
    await app.close();

    // ---- restart: same seed, new run (the old simulated path is gone) ----
    clock.advance(60 * 60_000);
    const run2 = new MockMarketProvider({ seed: 42, tokenCount: 12, clock: clock.now });
    ({ app } = await makeApp({ clock, provider: run2, config }));
    await app.services.bot.start();
    for (let i = 0; i < 20; i++) {
      await app.services.bot.tick();
      clock.advance(5_000);
    }

    // The old mint is never observed by the new run.
    expect(app.services.market.get(token.mint)).toBeUndefined();

    // The position is preserved and held at its last known price, flagged as not live.
    const pos = (await get<{ items: PositionView[] }>(app, '/api/portfolio/positions')).items.find((p) => p.mint === token.mint)!;
    expect(pos.quantity).toBe(posBefore.quantity);
    expect(pos.costBasisSol).toBe(posBefore.costBasisSol);
    expect(pos.priceStale).toBe(true);
    expect(pos.valuationMethod).toBe('last-known-price');
    expect(pos.markPriceSol).toBe(posBefore.lastPriceSol);

    // No false drawdown / emergency stop.
    const after = await get<PortfolioSummary>(app, '/api/portfolio');
    const status = (await get<{ bot: { killSwitch: { active: boolean } } }>(app, '/api/status')).bot;
    expect(status.killSwitch.active).toBe(false);
    // Only the old position's valuation method changed (AMM liquidation -> last known price minus
    // exit costs); new-run trades, if any, are excluded by comparing the old position alone.
    expect(Math.abs(pos.liquidationValueSol - posBefore.liquidationValueSol)).toBeLessThan(0.01 * posBefore.liquidationValueSol);
    expect(after.drawdownPct).toBeLessThan(5);

    // No SELL of the old position; exits are skipped for lack of data.
    const orders = (await get<{ items: PaperOrder[] }>(app, '/api/orders?limit=500')).items.filter((o) => o.mint === token.mint);
    expect(orders.map((o) => `${o.side}:${o.status}`)).toEqual(['BUY:FILLED']);
    const decisions = (await get<{ items: StrategyDecision[] }>(app, '/api/logs/decisions?limit=500')).items.filter((d) => d.mint === token.mint);
    expect(decisions.every((d) => d.action === 'SKIP')).toBe(true);
    expect(decisions.some((d) => /price unavailable/.test(d.reasons.join(' ')))).toBe(true);

    // Stale value is reported separately and excluded from live unrealized P&L.
    const views = (await get<{ items: PositionView[] }>(app, '/api/portfolio/positions')).items;
    const live = views.filter((v) => !v.priceStale).reduce((s, v) => s + v.unrealizedPnlSol, 0);
    expect(after.stalePositions).toBe(1);
    expect(after.staleUnrealizedPnlSol).toBeCloseTo(pos.unrealizedPnlSol, 12);
    expect(after.staleValueSol).toBeCloseTo(pos.liquidationValueSol, 12);
    expect(after.unrealizedPnlSol).toBeCloseTo(live, 12);
    expect(after.equitySol).toBeCloseTo(after.cashSol + after.positionsValueSol, 9);
    expect(before.stalePositions).toBe(0);
  });
});
