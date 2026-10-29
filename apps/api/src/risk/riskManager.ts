import type { Check, MarketObservation, PortfolioSummary, RiskConfig, Side } from '@spb/shared';

export interface RiskInput {
  side: Side;
  mint: string;
  /** BUY: SOL to spend (pre-fee). */
  sizeSol?: number;
  /** SELL: token quantity. */
  quantity?: number;
  observation: MarketObservation | undefined;
}

export interface RiskContext {
  now: number;
  config: RiskConfig;
  killSwitchActive: boolean;
  summary: PortfolioSummary;
  /** Fee-inclusive cost basis currently held in this mint (0 if none). */
  heldCostSol: number;
  heldQuantity: number;
  lastExitAt: number | null;
  lastSameSideFillAt: number | null;
  /** Estimated total cash debit for a BUY (size + fees). */
  estimatedCostSol?: number;
}

export interface RiskResult {
  approved: boolean;
  checks: Check[];
  reasons: string[];
}

/**
 * Pre-trade risk gate. Pure function: every simulated order (bot or manual)
 * passes through it inside the order mutex. Exits (SELL) are allowed while loss
 * limits are breached because they reduce risk; only the kill switch blocks them.
 */
export function evaluateRisk(input: RiskInput, ctx: RiskContext): RiskResult {
  const c = ctx.config;
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add('kill_switch', !ctx.killSwitchActive, ctx.killSwitchActive ? 'emergency stop is active - no new orders' : 'inactive');

  const obs = input.observation;
  if (!obs) add('price_fresh', false, 'no market observation for token');
  else {
    const age = ctx.now - obs.observedAt;
    add('price_fresh', age <= c.maxDataAgeMs && obs.priceSol != null, `observation age ${Math.round(age / 1000)}s (max ${c.maxDataAgeMs / 1000}s)`);
  }

  if (ctx.lastSameSideFillAt != null && c.duplicateWindowMs > 0) {
    const since = ctx.now - ctx.lastSameSideFillAt;
    add(
      'duplicate_window',
      since >= c.duplicateWindowMs,
      since < c.duplicateWindowMs ? `same-side order on this token ${Math.round(since / 1000)}s ago (window ${c.duplicateWindowMs / 1000}s)` : 'ok',
    );
  } else add('duplicate_window', true, 'ok');

  if (input.side === 'BUY') {
    const size = input.sizeSol ?? Number.NaN;
    const validSize = Number.isFinite(size) && size > 0;
    add('valid_size', validSize, validSize ? `${size} SOL` : 'size must be a positive number');
    add('max_order_size', validSize && size <= c.maxOrderSizeSol, `${size} SOL (max ${c.maxOrderSizeSol})`);
    const cost = ctx.estimatedCostSol ?? size;
    add('sufficient_balance', cost <= ctx.summary.cashSol, `needs ${cost.toFixed(6)} SOL, virtual cash ${ctx.summary.cashSol.toFixed(6)} SOL`);
    const exposureAfter = ctx.heldCostSol + cost;
    add(
      'max_exposure_per_token',
      exposureAfter <= c.maxExposurePerTokenSol + 1e-12,
      `${exposureAfter.toFixed(4)} SOL after order (max ${c.maxExposurePerTokenSol})`,
    );
    const isNew = ctx.heldQuantity <= 0;
    add(
      'max_concurrent_positions',
      !isNew || ctx.summary.openPositions < c.maxConcurrentPositions,
      `${ctx.summary.openPositions} open (max ${c.maxConcurrentPositions})`,
    );
    add(
      'daily_loss_limit',
      ctx.summary.dailyPnlSol > -c.maxDailyLossSol,
      `today ${ctx.summary.dailyPnlSol.toFixed(4)} SOL (limit -${c.maxDailyLossSol})`,
    );
    add('max_drawdown', ctx.summary.drawdownPct < c.maxDrawdownPct, `drawdown ${ctx.summary.drawdownPct.toFixed(2)}% (max ${c.maxDrawdownPct}%)`);
    const cooldownMs = c.cooldownMinutesAfterExit * 60_000;
    const inCooldown = ctx.lastExitAt != null && ctx.now - ctx.lastExitAt < cooldownMs;
    add('cooldown', !inCooldown, inCooldown ? `token exited recently (cooldown ${c.cooldownMinutesAfterExit} min)` : 'ok');
  } else {
    const qty = input.quantity ?? Number.NaN;
    add('has_position', ctx.heldQuantity > 0, ctx.heldQuantity > 0 ? `holding ${ctx.heldQuantity}` : 'no open position to sell');
    const valid = Number.isFinite(qty) && qty > 0 && qty <= ctx.heldQuantity * (1 + 1e-12);
    add('valid_quantity', valid, valid ? `${qty}` : 'quantity must be positive and <= held quantity');
  }

  const failed = checks.filter((x) => !x.passed);
  return { approved: failed.length === 0, checks, reasons: failed.map((x) => `${x.name}: ${x.detail}`) };
}

/** Reasons new BUYs are currently blocked at the portfolio level (shown on the dashboard). */
export function portfolioBuyBlocks(summary: PortfolioSummary, config: RiskConfig, killSwitchActive: boolean): string[] {
  const out: string[] = [];
  if (killSwitchActive) out.push('emergency stop active');
  if (summary.dailyPnlSol <= -config.maxDailyLossSol) out.push(`daily loss limit reached (${summary.dailyPnlSol.toFixed(4)} SOL)`);
  if (summary.drawdownPct >= config.maxDrawdownPct) out.push(`max drawdown reached (${summary.drawdownPct.toFixed(2)}%)`);
  if (summary.openPositions >= config.maxConcurrentPositions) out.push('max concurrent positions open');
  return out;
}
