import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, type MarketObservation, type Position } from '@spb/shared';
import { applyBuy, normalizePeakToExitReference, observationExitReferencePriceSol, poolFromObservation, simulateBuy } from '../src/paper/accounting';
import { evaluateExit } from '../src/strategy/momentumStrategy';
import { applyPeakNormalization, fingerprints, planPeakNormalization } from '../src/maintenance/peakNormalization';
import { ManualClock, StaticProvider, makeApp, makeObs, testConfig } from './helpers';

const costs = { tradingFeeBps: 100, slippageBufferBps: 50, networkFeeSol: 0.000105 };
const NOW = Date.UTC(2026, 5, 1, 12);
const MINT = 'mock_0001aaa';
const dir = mkdtempSync(join(tmpdir(), 'spb-peak-norm-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** Pool implying `implied` while the source quotes `quoted` (within the 15% tolerance). */
const gapObs = (now: number, implied: number, quoted: number): MarketObservation =>
  makeObs(now, { priceSol: quoted, quoteReserveSol: 200, baseReserve: 200 / implied });

/** A position opened under the OLD code: peak/last stored on the quoted basis. */
function legacyPosition(): Position {
  const entry = gapObs(NOW - 60_000, 1e-6, 1e-6);
  const p = poolFromObservation(entry);
  if (!p.ok) throw new Error(p.reason);
  const pos = applyBuy(undefined, simulateBuy(p.pool, 0.25, costs), { mint: MINT, symbol: 'SIM-AAA', now: NOW - 60_000, liquiditySol: 200 });
  // Old markToMarket stored the QUOTED price (1.17e-6) as peak/last while the pool implied 1.04e-6 (gap 12.5%).
  return { ...pos, peakPriceSol: 1.17e-6, lastPriceSol: 1.17e-6, lastPriceAt: NOW - 1_000 };
}

describe('peak-basis normalization', () => {
  // Market unchanged: pool still implies 1.04e-6, quote still 1.17e-6 (gap 12.5%, within the 15% tolerance).
  const obs = gapObs(NOW, 1.04e-6, 1.17e-6);
  const ctx = { now: NOW, strategy: DEFAULT_STRATEGY_CONFIG, risk: DEFAULT_RISK_CONFIG, costs };

  it('without normalization the basis change alone produces a FALSE trailing-stop SELL', () => {
    const r = evaluateExit(legacyPosition(), obs, ctx);
    expect(r.action).toBe('SELL');
    expect(r.reasons.some((x) => x.startsWith('trailing_stop'))).toBe(true);
  });

  it('after normalization the same unchanged market does not trigger a SELL', () => {
    const ref = observationExitReferencePriceSol(obs)!;
    const normalized = normalizePeakToExitReference(legacyPosition(), ref);
    expect(normalized.peakPriceSol).toBeCloseTo(1.04e-6, 15);
    expect(evaluateExit(normalized, obs, ctx).action).toBe('SKIP');
  });

  it('only lowers the peak, never raises it, and leaves every other field untouched', () => {
    const pos = legacyPosition();
    const lowered = normalizePeakToExitReference(pos, 1.0e-6);
    const unchanged = normalizePeakToExitReference(pos, 2.0e-6);
    expect(unchanged).toBe(pos);
    const { peakPriceSol: a, ...restA } = lowered;
    const { peakPriceSol: b, ...restB } = pos;
    expect(restA).toEqual(restB);
    expect(a).toBeLessThan(b);
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) expect(normalizePeakToExitReference(pos, bad)).toBe(pos);
  });

  it('plan + apply on a SQLite copy change only peakPriceSol (orders, audit, kv, other fields identical)', async () => {
    const file = join(dir, 'copy.db');
    const clock = new ManualClock(NOW - 60_000);
    const provider = new StaticProvider();
    provider.observations = [gapObs(clock.now(), 1e-6, 1e-6)];
    const { app } = await makeApp({ clock, provider, config: testConfig({ DATABASE_URL: `sqlite:${file}` }) });
    await app.services.market.refresh(true);
    await app.inject({ method: 'POST', url: '/api/orders', payload: { mode: 'PAPER', clientOrderId: 'norm-buy-0001', mint: MINT, side: 'BUY', sizeSol: 0.25 } });
    // Simulate the legacy state: peak/last on the quoted basis, and a recorded observation with a gap.
    const pos = (await app.services.repo.listPositions())[0];
    await app.services.repo.upsertPosition({ ...pos, peakPriceSol: 1.17e-6, lastPriceSol: 1.17e-6 });
    await app.services.repo.insertObservations([gapObs(NOW, 1.04e-6, 1.17e-6)]);
    await app.close();

    const db = new Database(file, { fileMustExist: true });
    const plan = planPeakNormalization(db, costs);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ mint: MINT, oldPeak: 1.17e-6, changed: true });
    expect(plan[0].newPeak).toBeCloseTo(1.04e-6, 15);
    expect(plan[0].exitBefore).toMatch(/^SELL: trailing_stop/);
    expect(plan[0].exitAfter).toMatch(/^SKIP/);

    const before = fingerprints(db);
    const res = applyPeakNormalization(db, plan);
    expect(res.updated).toBe(1);
    const after = fingerprints(db);
    expect(after.orders).toBe(before.orders);
    expect(after.audit).toBe(before.audit);
    expect(after.kv).toBe(before.kv);
    expect(after.positionsExceptPeak).toBe(before.positionsExceptPeak);
    expect(after.positions).not.toBe(before.positions);
    const stored = JSON.parse((db.prepare('SELECT payload FROM positions WHERE mint = ?').get(MINT) as { payload: string }).payload) as Position;
    expect(stored.peakPriceSol).toBeCloseTo(1.04e-6, 15);
    expect(stored.lastPriceSol).toBe(1.17e-6); // last price deliberately NOT modified
    // Re-planning is a no-op (idempotent).
    expect(planPeakNormalization(db, costs).every((r) => !r.changed)).toBe(true);
    db.close();
  });

  it('apply refuses a stale plan if the position changed after planning', () => {
    const file = join(dir, 'copy.db');
    const db = new Database(file, { fileMustExist: true });
    const stalePlan = [{ mint: MINT, symbol: 'SIM-AAA', oldPeak: 9e-6, newPeak: 1e-6, exitReference: 1e-6, observationAt: NOW, changed: true, skippedReason: null, exitBefore: '', exitAfter: '' }];
    const before = fingerprints(db);
    expect(() => applyPeakNormalization(db, stalePlan)).toThrow(/changed since the plan/);
    expect(fingerprints(db)).toEqual(before); // rolled back
    db.close();
  });
});
