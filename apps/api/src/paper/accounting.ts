import type { CostConfig, MarketObservation, PortfolioSummary, Position, PositionView } from '@spb/shared';

/**
 * EXECUTION MODEL (documented in docs/ARCHITECTURE.md#execution-model)
 *
 *  - Fills are modelled against a constant-product AMM (x*y=k) using the pool
 *    reserves in the latest validated observation. This is how pump.fun's
 *    bonding curve and PumpSwap pools price swaps, so price impact grows with
 *    order size relative to pool depth.
 *  - An extra adverse `slippageBufferBps` is applied on top of the modelled
 *    impact to account for latency / other traders moving the pool first.
 *  - `tradingFeeBps` is charged on the SOL leg of every swap; a flat
 *    `networkFeeSol` is charged per simulated transaction.
 *  - If the quoted price and the reserve-implied price disagree (up to the 15%
 *    tolerance), the fill is anchored to the worse of the two for the trader.
 *  - Orders are ALL-OR-NOTHING: no partial fills. If reserves are unavailable or
 *    inconsistent with the quoted price, the order is rejected rather than filled
 *    at a price the simulation cannot justify.
 *
 * PRICE CONVENTION (one basis for decisions, fills and position state)
 *  - Buy anchor       = max(quoted, reserve-implied): what a BUY is priced from.
 *  - Exit reference   = min(quoted, reserve-implied): what a SELL is priced from,
 *                       before AMM impact, slippage buffer and fees. Position
 *                       lastPriceSol / peakPriceSol and the trailing stop use ONLY
 *                       this basis.
 *  - Entry cost check = average BUY fill price (simulateBuy: anchor + AMM impact +
 *                       buffer; fees excluded) vs the exit reference. This counts
 *                       the quote/pool gap symmetrically, whichever side is higher.
 *  - Exit P&L         = estimated net SELL proceeds for the whole position
 *                       (simulateSell: exit reference + AMM impact + buffer + fee +
 *                       network fee) vs fee-inclusive cost basis. Identical to the
 *                       valuation's unrealized P&L, so each cost is counted once.
 *  Observations are discrete: a stop evaluated on one observation can fill far
 *  below its threshold if the market gaps before the next one.
 */
export const EXECUTION_MODEL =
  'constant-product AMM on observed reserves, anchored to the worse of quoted/reserve price, + slippage buffer + trading fee + flat network fee; all-or-nothing fills';

export interface PoolSnapshot {
  /** Reserve-implied spot price (quote / base). */
  spotPriceSol: number;
  quoteReserveSol: number;
  baseReserve: number;
  /**
   * Price quoted by the data source. When it differs from the reserve-implied price
   * (within tolerance), fills are anchored to whichever is WORSE for the trader:
   * buys at the higher price, sells at the lower. Defaults to spotPriceSol.
   */
  quotedPriceSol?: number;
}

/** Max allowed disagreement between quoted price and reserve-implied price. */
export const RESERVE_PRICE_TOLERANCE = 0.15;

export type PoolResult = { ok: true; pool: PoolSnapshot } | { ok: false; reason: string };

export function poolFromObservation(obs: MarketObservation): PoolResult {
  const { priceSol, quoteReserveSol: q, baseReserve: b } = obs;
  if (priceSol == null) return { ok: false, reason: 'price unavailable' };
  if (q == null || b == null) return { ok: false, reason: 'pool reserves unavailable - cannot model execution' };
  if (!Number.isFinite(priceSol) || priceSol <= 0) return { ok: false, reason: 'price is not a positive finite number' };
  if (!Number.isFinite(q) || !Number.isFinite(b)) return { ok: false, reason: 'pool reserves are not finite' };
  if (!(q > 0) || !(b > 0)) return { ok: false, reason: 'pool reserves are empty' };
  const implied = q / b;
  const diff = Math.abs(implied - priceSol) / priceSol;
  if (diff > RESERVE_PRICE_TOLERANCE) {
    return { ok: false, reason: `quoted price disagrees with reserve-implied price by ${(diff * 100).toFixed(1)}%` };
  }
  return { ok: true, pool: { spotPriceSol: implied, quoteReserveSol: q, baseReserve: b, quotedPriceSol: priceSol } };
}

/** Price a BUY is anchored to: the higher of quoted and reserve-implied. */
export function buyAnchorPriceSol(pool: PoolSnapshot): number {
  return Math.max(pool.spotPriceSol, pool.quotedPriceSol ?? pool.spotPriceSol);
}

/** Price a SELL is anchored to (pre-impact, pre-fee): the lower of quoted and reserve-implied. */
export function exitReferencePriceSol(pool: PoolSnapshot): number {
  return Math.min(pool.spotPriceSol, pool.quotedPriceSol ?? pool.spotPriceSol);
}

/** Exit reference for an observation, or null if no fill could be modelled from it. */
export function observationExitReferencePriceSol(obs: MarketObservation): number | null {
  const p = poolFromObservation(obs);
  return p.ok ? exitReferencePriceSol(p.pool) : null;
}

/** Quote/pool disagreement as a % of the lower price - symmetric in direction. */
export function quotePoolGapPct(pool: PoolSnapshot): number {
  return (buyAnchorPriceSol(pool) / exitReferencePriceSol(pool) - 1) * 100;
}

export interface BuySimulation {
  quantity: number;
  priceSol: number;
  spotPriceSol: number;
  /** Exit reference price of the pool the fill was modelled on (position-state basis). */
  exitReferencePriceSol: number;
  grossSol: number;
  tradingFeeSol: number;
  networkFeeSol: number;
  totalCostSol: number;
  priceImpactPct: number;
}

export interface SellSimulation {
  quantity: number;
  priceSol: number;
  spotPriceSol: number;
  /** Exit reference price of the pool the fill was modelled on (position-state basis). */
  exitReferencePriceSol: number;
  grossSol: number;
  tradingFeeSol: number;
  networkFeeSol: number;
  netProceedsSol: number;
  priceImpactPct: number;
}

function assertPositiveFinite(n: number, what: string) {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${what} must be a positive finite number`);
}

/** Total virtual cash a BUY of `grossSol` will debit: size + trading fee + network fee (same as simulateBuy). */
export function estimateBuyTotalCostSol(grossSol: number, costs: CostConfig): number {
  return grossSol + grossSol * (costs.tradingFeeBps / 10_000) + costs.networkFeeSol;
}

/** Spend `grossSol` SOL (fees charged on top) to buy tokens. */
export function simulateBuy(pool: PoolSnapshot, grossSol: number, costs: CostConfig): BuySimulation {
  assertPositiveFinite(grossSol, 'buy size');
  const { quoteReserveSol: q, baseReserve: b } = pool;
  const ammOut = (b * grossSol) / (q + grossSol);
  // Conservative anchor: never buy cheaper than the quoted market price.
  const anchor = buyAnchorPriceSol(pool);
  const quantity = ammOut * (pool.spotPriceSol / anchor) * (1 - costs.slippageBufferBps / 10_000);
  const priceSol = grossSol / quantity;
  const tradingFeeSol = grossSol * (costs.tradingFeeBps / 10_000);
  return {
    quantity,
    priceSol,
    spotPriceSol: pool.spotPriceSol,
    exitReferencePriceSol: exitReferencePriceSol(pool),
    grossSol,
    tradingFeeSol,
    networkFeeSol: costs.networkFeeSol,
    totalCostSol: estimateBuyTotalCostSol(grossSol, costs),
    priceImpactPct: (priceSol / pool.spotPriceSol - 1) * 100,
  };
}

/** Sell `quantity` tokens into the pool. */
export function simulateSell(pool: PoolSnapshot, quantity: number, costs: CostConfig): SellSimulation {
  assertPositiveFinite(quantity, 'sell quantity');
  const { quoteReserveSol: q, baseReserve: b } = pool;
  const ammOut = (q * quantity) / (b + quantity);
  // Conservative anchor: never sell above the quoted market price.
  const anchor = exitReferencePriceSol(pool);
  const grossSol = ammOut * (anchor / pool.spotPriceSol) * (1 - costs.slippageBufferBps / 10_000);
  const tradingFeeSol = grossSol * (costs.tradingFeeBps / 10_000);
  const priceSol = grossSol / quantity;
  return {
    quantity,
    priceSol,
    spotPriceSol: pool.spotPriceSol,
    exitReferencePriceSol: exitReferencePriceSol(pool),
    grossSol,
    tradingFeeSol,
    networkFeeSol: costs.networkFeeSol,
    netProceedsSol: grossSol - tradingFeeSol - costs.networkFeeSol,
    priceImpactPct: (1 - priceSol / pool.spotPriceSol) * 100,
  };
}

/**
 * One-time migration helper for positions opened before the price convention existed:
 * their stored peak may be on the quoted basis. Lowering it to the current exit reference
 * (never raising it) removes a basis-change artefact without inventing a new high.
 * Every other field is returned unchanged.
 */
export function normalizePeakToExitReference(position: Position, exitReference: number): Position {
  if (!Number.isFinite(exitReference) || exitReference <= 0) return position;
  return position.peakPriceSol > exitReference ? { ...position, peakPriceSol: exitReference } : position;
}

export interface EntryCostEstimate {
  /** Average BUY fill price vs exit reference, in % (AMM impact + buffer + quote/pool gap; fees excluded). */
  totalPct: number;
  /** AMM impact + slippage buffer relative to the buy anchor, in %. */
  ammAndBufferPct: number;
  /** Symmetric quote/pool gap, in %. */
  gapPct: number;
  buy: BuySimulation;
}

/** Entry cost exactly as the simulated BUY would realise it - the strategy and the fill cannot disagree. */
export function estimateEntryCost(pool: PoolSnapshot, sizeSol: number, costs: CostConfig): EntryCostEstimate {
  const buy = simulateBuy(pool, sizeSol, costs);
  return {
    totalPct: (buy.priceSol / exitReferencePriceSol(pool) - 1) * 100,
    ammAndBufferPct: (buy.priceSol / buyAnchorPriceSol(pool) - 1) * 100,
    gapPct: quotePoolGapPct(pool),
    buy,
  };
}

export interface ExitEstimate {
  /** Estimated net SOL from selling the whole position now (after impact, buffer, fee and network fee). */
  netProceedsSol: number;
  /** (net proceeds - fee-inclusive cost basis) / cost basis, in %. */
  netPnlPct: number;
  exitReferencePriceSol: number;
  sell: SellSimulation;
}

/** Executable exit estimate for a whole position: the same simulateSell the SELL fill and the valuation use. */
export function estimateExit(position: Pick<Position, 'quantity' | 'costBasisSol'>, pool: PoolSnapshot, costs: CostConfig): ExitEstimate {
  const sell = simulateSell(pool, position.quantity, costs);
  return {
    netProceedsSol: sell.netProceedsSol,
    netPnlPct: position.costBasisSol > 0 ? ((sell.netProceedsSol - position.costBasisSol) / position.costBasisSol) * 100 : 0,
    exitReferencePriceSol: sell.exitReferencePriceSol,
    sell,
  };
}

/** Estimated total adverse price movement (%) for buying `sizeSol` - used by the strategy filter. */
export function estimateBuyImpactPct(quoteReserveSol: number, sizeSol: number, slippageBufferBps: number): number {
  // avg price / spot = (q + x) / q for an x*y=k pool; buffer reduces tokens received.
  const ammFactor = (quoteReserveSol + sizeSol) / quoteReserveSol;
  return (ammFactor / (1 - slippageBufferBps / 10_000) - 1) * 100;
}

/** Apply a buy fill to an existing (or new) position. Fees are capitalized into cost basis. */
export function applyBuy(
  existing: Position | undefined,
  fill: BuySimulation,
  meta: { mint: string; symbol: string; now: number; liquiditySol: number | null },
): Position {
  if (!existing) {
    return {
      mint: meta.mint,
      symbol: meta.symbol,
      quantity: fill.quantity,
      costBasisSol: fill.totalCostSol,
      avgEntryPriceSol: fill.totalCostSol / fill.quantity,
      avgFillPriceSol: fill.priceSol,
      openedAt: meta.now,
      updatedAt: meta.now,
      entryLiquiditySol: meta.liquiditySol,
      peakPriceSol: fill.exitReferencePriceSol,
      lastPriceSol: fill.exitReferencePriceSol,
      lastPriceAt: meta.now,
      realizedPnlSol: 0,
    };
  }
  const quantity = existing.quantity + fill.quantity;
  const costBasisSol = existing.costBasisSol + fill.totalCostSol;
  return {
    ...existing,
    quantity,
    costBasisSol,
    avgEntryPriceSol: costBasisSol / quantity,
    avgFillPriceSol: (existing.avgFillPriceSol * existing.quantity + fill.priceSol * fill.quantity) / quantity,
    updatedAt: meta.now,
    peakPriceSol: Math.max(existing.peakPriceSol, fill.exitReferencePriceSol),
    lastPriceSol: fill.exitReferencePriceSol,
    lastPriceAt: meta.now,
  };
}

/** Quantities below this fraction of a position are treated as dust and closed. */
const DUST_FRACTION = 1e-9;

export interface SellApplication {
  position: Position | null;
  realizedPnlSol: number;
  costBasisReleasedSol: number;
}

/** Apply a sell fill: release proportional cost basis and realize P&L net of exit costs. */
export function applySell(existing: Position, fill: SellSimulation, now: number): SellApplication {
  if (fill.quantity > existing.quantity * (1 + 1e-12)) throw new RangeError('cannot sell more than the open quantity');
  const fraction = Math.min(1, fill.quantity / existing.quantity);
  const closing = 1 - fraction < DUST_FRACTION;
  const costBasisReleasedSol = closing ? existing.costBasisSol : existing.costBasisSol * fraction;
  const realizedPnlSol = fill.netProceedsSol - costBasisReleasedSol;
  if (closing) return { position: null, realizedPnlSol, costBasisReleasedSol };
  const quantity = existing.quantity - fill.quantity;
  const costBasisSol = existing.costBasisSol - costBasisReleasedSol;
  return {
    position: {
      ...existing,
      quantity,
      costBasisSol,
      // Proportional release keeps the average entry price unchanged.
      avgEntryPriceSol: costBasisSol / quantity,
      updatedAt: now,
      lastPriceSol: fill.exitReferencePriceSol,
      lastPriceAt: now,
      realizedPnlSol: existing.realizedPnlSol + realizedPnlSol,
    },
    realizedPnlSol,
    costBasisReleasedSol,
  };
}

/**
 * Value a position. Unrealized P&L is computed CONSERVATIVELY against the
 * estimated liquidation value (what selling everything now would return after
 * modelled impact and fees), not the raw spot mark.
 */
export function valuePosition(
  p: Position,
  obs: MarketObservation | undefined,
  now: number,
  maxDataAgeMs: number,
  costs: CostConfig,
): PositionView {
  let markPriceSol = p.lastPriceSol;
  let priceStale = true;
  let liquidationValueSol: number;
  let valuationMethod: PositionView['valuationMethod'] = 'last-known-price';

  const pool = obs && obs.priceSol != null ? poolFromObservation(obs) : null;
  if (obs && pool?.ok) {
    markPriceSol = exitReferencePriceSol(pool.pool);
    priceStale = now - obs.observedAt > maxDataAgeMs;
    liquidationValueSol = Math.max(0, simulateSell(pool.pool, p.quantity, costs).netProceedsSol);
    valuationMethod = 'amm-liquidation';
  } else {
    // No EXECUTABLE price: no observation (e.g. a mock token from an earlier run), or an
    // observation no SELL could be modelled from (reserves missing, quote/pool gap beyond
    // tolerance). Hold the last known exit-reference price - never the raw quote, which is
    // the wrong basis and usually the higher one - and apply the exit costs that need no
    // reserves (buffer, fee, network fee). Flagged stale: not a live, realisable value.
    liquidationValueSol = Math.max(
      0,
      markPriceSol * p.quantity * (1 - costs.slippageBufferBps / 10_000) * (1 - costs.tradingFeeBps / 10_000) - costs.networkFeeSol,
    );
  }

  const unrealizedPnlSol = liquidationValueSol - p.costBasisSol;
  return {
    ...p,
    markPriceSol,
    marketValueSol: markPriceSol * p.quantity,
    liquidationValueSol,
    unrealizedPnlSol,
    unrealizedPnlPct: p.costBasisSol > 0 ? (unrealizedPnlSol / p.costBasisSol) * 100 : 0,
    priceStale,
    valuationMethod,
  };
}

export interface AccountState {
  startingBalanceSol: number;
  cashSol: number;
  realizedPnlSol: number;
  feesPaidSol: number;
  peakEquitySol: number;
  dayKey: string;
  dayStartEquitySol: number;
  createdAt: number;
}

export function summarize(account: AccountState, views: PositionView[], now: number): PortfolioSummary {
  // Equity keeps stale positions at their last known value (dropping them would fake a
  // drawdown), but unrealized P&L is split so stale marks are never presented as live.
  const positionsValueSol = views.reduce((s, v) => s + v.liquidationValueSol, 0);
  const live = views.filter((v) => !v.priceStale);
  const stale = views.filter((v) => v.priceStale);
  const unrealizedPnlSol = live.reduce((s, v) => s + v.unrealizedPnlSol, 0);
  const staleUnrealizedPnlSol = stale.reduce((s, v) => s + v.unrealizedPnlSol, 0);
  const staleValueSol = stale.reduce((s, v) => s + v.liquidationValueSol, 0);
  const exposureSol = views.reduce((s, v) => s + v.costBasisSol, 0);
  const equitySol = account.cashSol + positionsValueSol;
  const peak = Math.max(account.peakEquitySol, equitySol);
  return {
    mode: 'PAPER',
    virtual: true,
    startingBalanceSol: account.startingBalanceSol,
    cashSol: account.cashSol,
    positionsValueSol,
    equitySol,
    realizedPnlSol: account.realizedPnlSol,
    unrealizedPnlSol,
    staleUnrealizedPnlSol,
    stalePositions: stale.length,
    staleValueSol,
    totalPnlSol: equitySol - account.startingBalanceSol,
    totalReturnPct: ((equitySol - account.startingBalanceSol) / account.startingBalanceSol) * 100,
    feesPaidSol: account.feesPaidSol,
    peakEquitySol: peak,
    drawdownPct: peak > 0 ? Math.max(0, ((peak - equitySol) / peak) * 100) : 0,
    dayStartEquitySol: account.dayStartEquitySol,
    dailyPnlSol: equitySol - account.dayStartEquitySol,
    openPositions: views.length,
    exposureSol,
    asOf: now,
  };
}
