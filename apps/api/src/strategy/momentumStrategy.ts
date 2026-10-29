import type { Check, CostConfig, MarketObservation, Position, RiskConfig, StrategyConfig } from '@spb/shared';
import { estimateEntryCost, estimateExit, poolFromObservation } from '../paper/accounting';

/**
 * BASELINE MOMENTUM STRATEGY - fully deterministic, rule-based, transparent.
 * No LLM or other non-deterministic component participates in decisions.
 *
 * ENTRY (all must pass; any unavailable input => SKIP):
 *   fresh data, price, liquidity >= min, 5m txns >= min, 5m volume >= min,
 *   min <= 5m price change <= max, buy/sell ratio >= min, token age within bounds,
 *   estimated price impact <= max, not already held, not in post-exit cooldown.
 * EXIT (first match wins): take profit, stop loss, trailing stop, max hold time,
 *   liquidity collapse vs entry.
 *
 * This is a baseline for experimentation. Nothing here implies profitability.
 */

export interface EntryContext {
  now: number;
  strategy: StrategyConfig;
  risk: RiskConfig;
  costs: CostConfig;
  held: boolean;
  lastExitAt: number | null;
}

export interface StrategyResult {
  action: 'BUY' | 'SELL' | 'SKIP';
  reasons: string[];
  checks: Check[];
  sizeSol?: number;
  fraction?: number;
}

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

export function evaluateEntry(obs: MarketObservation, ctx: EntryContext): StrategyResult {
  const s = ctx.strategy;
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  const age = ctx.now - obs.observedAt;
  add('data_fresh', age <= ctx.risk.maxDataAgeMs, `data age ${Math.round(age / 1000)}s (max ${ctx.risk.maxDataAgeMs / 1000}s)`);
  add('price_available', obs.priceSol != null, obs.priceSol != null ? `price ${obs.priceSol.toExponential(4)} SOL` : 'price unavailable');

  if (obs.quoteReserveSol == null) add('min_liquidity', false, 'liquidity unavailable');
  else add('min_liquidity', obs.quoteReserveSol >= s.minLiquiditySol, `${fmt(obs.quoteReserveSol)} SOL (min ${s.minLiquiditySol})`);

  if (obs.buys5m == null || obs.sells5m == null) add('min_txns_5m', false, '5m transaction counts unavailable');
  else {
    const tx = obs.buys5m + obs.sells5m;
    add('min_txns_5m', tx >= s.minTxns5m, `${tx} txns (min ${s.minTxns5m})`);
  }

  if (obs.volume5mSol == null) add('min_volume_5m', false, '5m volume unavailable');
  else add('min_volume_5m', obs.volume5mSol >= s.minVolume5mSol, `${fmt(obs.volume5mSol)} SOL (min ${s.minVolume5mSol})`);

  if (obs.priceChange5mPct == null) add('momentum_5m', false, '5m price change unavailable');
  else
    add(
      'momentum_5m',
      obs.priceChange5mPct >= s.minPriceChange5mPct && obs.priceChange5mPct <= s.maxPriceChange5mPct,
      `${fmt(obs.priceChange5mPct)}% (allowed ${s.minPriceChange5mPct}% .. ${s.maxPriceChange5mPct}%)`,
    );

  if (obs.buys5m == null || obs.sells5m == null) add('buy_sell_ratio', false, 'buy/sell counts unavailable');
  else {
    const ratio = obs.sells5m === 0 ? (obs.buys5m > 0 ? Number.POSITIVE_INFINITY : 0) : obs.buys5m / obs.sells5m;
    add('buy_sell_ratio', ratio >= s.minBuySellRatio, `${fmt(ratio)} (min ${s.minBuySellRatio})`);
  }

  if (obs.pairCreatedAt == null) {
    add('token_age', !s.requireTokenAge, s.requireTokenAge ? 'token age unavailable (required)' : 'token age unavailable (not required)');
  } else {
    const mins = (ctx.now - obs.pairCreatedAt) / 60_000;
    add(
      'token_age',
      mins >= s.minTokenAgeMinutes && mins <= s.maxTokenAgeMinutes,
      `${fmt(mins, 1)} min (allowed ${s.minTokenAgeMinutes} .. ${s.maxTokenAgeMinutes})`,
    );
  }

  const pool = poolFromObservation(obs);
  if (!pool.ok) {
    add('max_price_impact', false, `cannot estimate execution cost: ${pool.reason}`);
  } else {
    // The same simulateBuy the fill uses, measured against the exit reference price, so the
    // quote/pool gap is counted whichever side is higher (see PRICE CONVENTION in accounting.ts).
    const est = estimateEntryCost(pool.pool, s.orderSizeSol, ctx.costs);
    add(
      'max_price_impact',
      est.totalPct <= s.maxPriceImpactPct,
      `est. ${fmt(est.totalPct)}% for ${s.orderSizeSol} SOL = AMM+buffer ${fmt(est.ammAndBufferPct)}% + quote/pool gap ${fmt(est.gapPct)}% (max ${s.maxPriceImpactPct}%)`,
    );
  }

  add('not_already_held', !ctx.held, ctx.held ? 'position already open' : 'no open position');

  const cooldownMs = ctx.risk.cooldownMinutesAfterExit * 60_000;
  const inCooldown = ctx.lastExitAt != null && ctx.now - ctx.lastExitAt < cooldownMs;
  add(
    'cooldown',
    !inCooldown,
    inCooldown ? `exited ${Math.round((ctx.now - (ctx.lastExitAt ?? 0)) / 60_000)} min ago (cooldown ${ctx.risk.cooldownMinutesAfterExit} min)` : 'not in cooldown',
  );

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    return { action: 'SKIP', reasons: failed.map((c) => `${c.name}: ${c.detail}`), checks };
  }
  return { action: 'BUY', reasons: ['all entry rules passed'], checks, sizeSol: s.orderSizeSol };
}

export interface ExitContext {
  now: number;
  strategy: StrategyConfig;
  risk: RiskConfig;
  costs: CostConfig;
}

export function evaluateExit(position: Position, obs: MarketObservation | undefined, ctx: ExitContext): StrategyResult {
  const s = ctx.strategy;
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  if (!obs || obs.priceSol == null) {
    add('data_available', false, 'no price observation for held token');
    return { action: 'SKIP', reasons: ['cannot evaluate exit: price unavailable'], checks };
  }
  const age = ctx.now - obs.observedAt;
  if (age > ctx.risk.maxDataAgeMs) {
    add('data_fresh', false, `data age ${Math.round(age / 1000)}s exceeds ${ctx.risk.maxDataAgeMs / 1000}s`);
    return { action: 'SKIP', reasons: ['cannot evaluate exit: stale data'], checks };
  }
  add('data_fresh', true, `data age ${Math.round(age / 1000)}s`);

  // Decisions use the executable estimate the SELL fill would realise from this observation.
  const pool = poolFromObservation(obs);
  if (!pool.ok) {
    add('exit_executable', false, `cannot model a SELL: ${pool.reason}`);
    return { action: 'SKIP', reasons: [`cannot evaluate exit: ${pool.reason}`], checks };
  }
  add('exit_executable', true, 'SELL can be modelled from this observation');

  const est = estimateExit(position, pool.pool, ctx.costs);
  const pnlPct = est.netPnlPct;
  // Trailing stop on the exit-reference basis only (position.peakPriceSol uses the same basis).
  const ref = est.exitReferencePriceSol;
  const peak = Math.max(position.peakPriceSol, ref);
  const fromPeakPct = ((peak - ref) / peak) * 100;
  const heldMin = (ctx.now - position.openedAt) / 60_000;
  const pnlDetail = `net P&L at estimated executable exit ${fmt(pnlPct)}% (after impact, slippage, fees; fill may differ if the market gaps)`;

  const triggers: [string, boolean, string][] = [
    ['take_profit', pnlPct >= s.takeProfitPct, `${pnlDetail} (target +${s.takeProfitPct}%)`],
    ['stop_loss', pnlPct <= -s.stopLossPct, `${pnlDetail} (stop -${s.stopLossPct}%)`],
    [
      // Activates once the exit reference has exceeded the fee-inclusive break-even price.
      'trailing_stop',
      peak > position.avgEntryPriceSol && fromPeakPct >= s.trailingStopPct,
      `exit price ${fmt(fromPeakPct)}% below peak (trail ${s.trailingStopPct}%, active once above entry)`,
    ],
    ['max_hold_time', heldMin >= s.maxHoldMinutes, `held ${fmt(heldMin, 1)} min (max ${s.maxHoldMinutes})`],
  ];
  if (position.entryLiquiditySol != null && obs.quoteReserveSol != null && position.entryLiquiditySol > 0) {
    const drop = ((position.entryLiquiditySol - obs.quoteReserveSol) / position.entryLiquiditySol) * 100;
    triggers.push(['liquidity_drop', drop >= s.exitOnLiquidityDropPct, `liquidity ${fmt(drop)}% below entry (max ${s.exitOnLiquidityDropPct}%)`]);
  }
  // For exits a "passed" check means the exit condition did NOT fire.
  for (const [name, fired, detail] of triggers) add(name, !fired, detail);

  const fired = triggers.filter(([, f]) => f);
  if (fired.length > 0) {
    return { action: 'SELL', reasons: fired.map(([n, , d]) => `${n}: ${d}`), checks, fraction: 1 };
  }
  return { action: 'SKIP', reasons: ['hold: no exit condition met'], checks };
}
