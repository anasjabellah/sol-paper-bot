import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_CONFIG, type PortfolioSummary } from '@spb/shared';
import { evaluateRisk, portfolioBuyBlocks, type RiskContext, type RiskInput } from '../src/risk/riskManager';
import { makeObs } from './helpers';

const NOW = Date.UTC(2026, 5, 1);
const summary = (o: Partial<PortfolioSummary> = {}): PortfolioSummary => ({
  mode: 'PAPER',
  virtual: true,
  startingBalanceSol: 10,
  cashSol: 10,
  positionsValueSol: 0,
  equitySol: 10,
  realizedPnlSol: 0,
  unrealizedPnlSol: 0,
  staleUnrealizedPnlSol: 0,
  stalePositions: 0,
  staleValueSol: 0,
  totalPnlSol: 0,
  totalReturnPct: 0,
  feesPaidSol: 0,
  peakEquitySol: 10,
  drawdownPct: 0,
  dayStartEquitySol: 10,
  dailyPnlSol: 0,
  openPositions: 0,
  exposureSol: 0,
  asOf: NOW,
  ...o,
});
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  now: NOW,
  config: DEFAULT_RISK_CONFIG,
  killSwitchActive: false,
  summary: summary(),
  heldCostSol: 0,
  heldQuantity: 0,
  lastExitAt: null,
  lastSameSideFillAt: null,
  estimatedCostSol: 0.5051,
  ...o,
});
const buy = (o: Partial<RiskInput> = {}): RiskInput => ({ side: 'BUY', mint: 'mock_0001aaa', sizeSol: 0.5, observation: makeObs(NOW), ...o });
const failed = (r: { checks: { name: string; passed: boolean }[] }) => r.checks.filter((c) => !c.passed).map((c) => c.name);

describe('evaluateRisk - BUY', () => {
  it('approves a normal order', () => {
    const r = evaluateRisk(buy(), ctx());
    expect(r.approved).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('kill switch blocks everything', () => {
    expect(failed(evaluateRisk(buy(), ctx({ killSwitchActive: true })))).toContain('kill_switch');
    const sell = evaluateRisk({ side: 'SELL', mint: 'm', quantity: 1, observation: makeObs(NOW) }, ctx({ killSwitchActive: true, heldQuantity: 10 }));
    expect(sell.approved).toBe(false);
    expect(failed(sell)).toContain('kill_switch');
  });

  it.each([
    ['max_order_size', buy({ sizeSol: 2 }), ctx({ estimatedCostSol: 2.02 })],
    ['sufficient_balance', buy(), ctx({ summary: summary({ cashSol: 0.1 }) })],
    ['max_exposure_per_token', buy(), ctx({ heldCostSol: 0.8, heldQuantity: 1 })],
    ['max_concurrent_positions', buy(), ctx({ summary: summary({ openPositions: 3 }) })],
    ['daily_loss_limit', buy(), ctx({ summary: summary({ dailyPnlSol: -1.6 }) })],
    ['max_drawdown', buy(), ctx({ summary: summary({ drawdownPct: 30 }) })],
    ['cooldown', buy(), ctx({ lastExitAt: NOW - 60_000 })],
    ['duplicate_window', buy(), ctx({ lastSameSideFillAt: NOW - 5_000 })],
    ['price_fresh', buy({ observation: makeObs(NOW - 60_000) }), ctx()],
    ['price_fresh', buy({ observation: undefined }), ctx()],
    ['valid_size', buy({ sizeSol: -1 }), ctx()],
  ])('rejects on %s', (name, input, c) => {
    const r = evaluateRisk(input, c);
    expect(r.approved).toBe(false);
    expect(failed(r)).toContain(name);
  });

  it('adding to an existing position does not count toward the concurrency limit', () => {
    const r = evaluateRisk(buy({ sizeSol: 0.1 }), ctx({ heldCostSol: 0.2, heldQuantity: 1, summary: summary({ openPositions: 3 }), estimatedCostSol: 0.101 }));
    expect(failed(r)).not.toContain('max_concurrent_positions');
  });
});

describe('evaluateRisk - SELL', () => {
  const sell = (q: number): RiskInput => ({ side: 'SELL', mint: 'm', quantity: q, observation: makeObs(NOW) });
  it('allows exits even when loss limits are breached', () => {
    const r = evaluateRisk(sell(5), ctx({ heldQuantity: 10, summary: summary({ dailyPnlSol: -5, drawdownPct: 60 }) }));
    expect(r.approved).toBe(true);
  });
  it('rejects selling without a position or more than held', () => {
    expect(failed(evaluateRisk(sell(1), ctx()))).toContain('has_position');
    expect(failed(evaluateRisk(sell(11), ctx({ heldQuantity: 10 })))).toContain('valid_quantity');
  });
});

describe('portfolioBuyBlocks', () => {
  it('lists active portfolio-level blocks', () => {
    expect(portfolioBuyBlocks(summary(), DEFAULT_RISK_CONFIG, false)).toEqual([]);
    const b = portfolioBuyBlocks(summary({ dailyPnlSol: -2, drawdownPct: 30, openPositions: 3 }), DEFAULT_RISK_CONFIG, true);
    expect(b).toHaveLength(4);
  });
});
