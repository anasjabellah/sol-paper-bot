import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, MarketObservationSchema, type CostConfig, type MarketObservation, type Position } from '@spb/shared';
import { normalizePeakToExitReference, observationExitReferencePriceSol } from '../paper/accounting';
import { evaluateExit } from '../strategy/momentumStrategy';

/**
 * One-time normalization of open positions' stored peak price to the exit-reference basis
 * (see PRICE CONVENTION in paper/accounting.ts). Operates on a raw SQLite handle so it can
 * run as an offline maintenance step while the API is STOPPED. Only `peakPriceSol` inside
 * positions.payload can change; nothing else is written.
 */

export interface PeakPlanRow {
  mint: string;
  symbol: string;
  oldPeak: number;
  newPeak: number;
  exitReference: number | null;
  observationAt: number | null;
  changed: boolean;
  skippedReason: string | null;
  /** Exit decision on the latest observation with the old vs the normalized peak. */
  exitBefore: string;
  exitAfter: string;
}

export interface Fingerprints {
  positions: string;
  positionsExceptPeak: string;
  orders: string;
  audit: string;
  kv: string;
  counts: { positions: number; orders: number; audit: number };
}

const h = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

export function fingerprints(db: Database.Database): Fingerprints {
  const positions = db.prepare('SELECT mint, payload, updated_at FROM positions ORDER BY mint').all() as { mint: string; payload: string; updated_at: number }[];
  const orders = db.prepare('SELECT * FROM orders ORDER BY id').all();
  const audit = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  const kv = db.prepare('SELECT key, value FROM kv ORDER BY key').all();
  const withoutPeak = positions.map((r) => {
    const { peakPriceSol: _peak, ...rest } = JSON.parse(r.payload) as Position;
    return [r.mint, rest, r.updated_at];
  });
  return {
    positions: h(positions),
    positionsExceptPeak: h(withoutPeak),
    orders: h(orders),
    audit: h(audit),
    kv: h(kv),
    counts: { positions: positions.length, orders: orders.length, audit: audit.length },
  };
}

function latestObservation(db: Database.Database, mint: string): MarketObservation | null {
  const row = db.prepare('SELECT payload FROM observations WHERE mint = ? ORDER BY observed_at DESC, id DESC LIMIT 1').get(mint) as { payload: string } | undefined;
  if (!row) return null;
  const parsed = MarketObservationSchema.safeParse(JSON.parse(row.payload));
  return parsed.success ? parsed.data : null;
}

const describe = (r: { action: string; reasons: string[] }) => `${r.action}: ${r.reasons[0] ?? ''}`;

/** Read-only: what normalization would do for each open position, using the latest recorded observation. */
export function planPeakNormalization(db: Database.Database, costs: CostConfig): PeakPlanRow[] {
  const rows = db.prepare('SELECT payload FROM positions ORDER BY mint').all() as { payload: string }[];
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as Position;
    const obs = latestObservation(db, p.mint);
    const ref = obs ? observationExitReferencePriceSol(obs) : null;
    const base = { mint: p.mint, symbol: p.symbol, oldPeak: p.peakPriceSol, exitReference: ref, observationAt: obs?.observedAt ?? null };
    if (!obs || ref === null) {
      return { ...base, newPeak: p.peakPriceSol, changed: false, skippedReason: obs ? 'latest observation cannot be priced' : 'no recorded observation', exitBefore: 'n/a', exitAfter: 'n/a' };
    }
    const normalized = normalizePeakToExitReference(p, ref);
    // Evaluate as of the observation time, so the comparison isolates the peak-basis change.
    const ctx = { now: obs.observedAt, strategy: DEFAULT_STRATEGY_CONFIG, risk: DEFAULT_RISK_CONFIG, costs };
    return {
      ...base,
      newPeak: normalized.peakPriceSol,
      changed: normalized.peakPriceSol !== p.peakPriceSol,
      skippedReason: null,
      exitBefore: describe(evaluateExit(p, obs, ctx)),
      exitAfter: describe(evaluateExit(normalized, obs, ctx)),
    };
  });
}

/**
 * Applies a plan inside one transaction. Only rows marked `changed` are updated, and only
 * their payload's peakPriceSol (positions.updated_at is left as-is). Verifies afterwards that
 * orders, audit log, kv and every other position field are byte-identical.
 */
export function applyPeakNormalization(db: Database.Database, plan: PeakPlanRow[]): { updated: number; before: Fingerprints; after: Fingerprints } {
  const before = fingerprints(db);
  let updated = 0;
  db.transaction(() => {
    for (const row of plan.filter((x) => x.changed)) {
      const cur = db.prepare('SELECT payload FROM positions WHERE mint = ?').get(row.mint) as { payload: string } | undefined;
      if (!cur) throw new Error(`position ${row.mint} disappeared`);
      const p = JSON.parse(cur.payload) as Position;
      if (p.peakPriceSol !== row.oldPeak) throw new Error(`position ${row.mint} changed since the plan was made`);
      db.prepare('UPDATE positions SET payload = ? WHERE mint = ?').run(JSON.stringify({ ...p, peakPriceSol: row.newPeak }), row.mint);
      updated++;
    }
    const after = fingerprints(db);
    for (const k of ['positionsExceptPeak', 'orders', 'audit', 'kv'] as const) {
      if (after[k] !== before[k]) throw new Error(`verification failed: ${k} changed - transaction rolled back`);
    }
  })();
  return { updated, before, after: fingerprints(db) };
}
