import type { MarketObservation, MarketSource } from './schemas';

export type Side = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderOrigin = 'bot' | 'manual';
export type OrderStatus = 'FILLED' | 'REJECTED';
export type DecisionAction = 'BUY' | 'SELL' | 'SKIP';

/** One named rule/risk check with its outcome - recorded on every decision and order. */
export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FillDetails {
  /** Token quantity bought or sold. */
  quantity: number;
  /** Average execution price in SOL per token, excluding fees. */
  priceSol: number;
  /** Spot (pre-trade) price in the observation the fill was modelled on. */
  spotPriceSol: number;
  /** SOL leg of the swap before fees. */
  grossSol: number;
  tradingFeeSol: number;
  networkFeeSol: number;
  /** Modelled AMM price impact + slippage buffer, as % vs spot. */
  priceImpactPct: number;
  /** Signed change to virtual cash (negative for buys). */
  cashDeltaSol: number;
  /** SELL only: realized P&L after entry AND exit costs. */
  realizedPnlSol: number | null;
  /** SELL only: cost basis released by this sale. */
  costBasisReleasedSol: number | null;
  observationAt: number;
  model: string;
  /** Price quoted by the data source in the observation the fill used (absent on older records). */
  quotedPriceSol?: number;
  /** min(quoted, reserve-implied) in that observation - the exit-reference basis (absent on older records). */
  exitReferencePriceSol?: number;
}

export interface PaperOrder {
  id: string;
  clientOrderId: string;
  mint: string;
  symbol: string;
  side: Side;
  type: OrderType;
  origin: OrderOrigin;
  status: OrderStatus;
  requested: { sizeSol?: number; fraction?: number; limitPriceSol?: number };
  createdAt: number;
  rejectReason: string | null;
  riskChecks: Check[];
  fill: FillDetails | null;
  simulated: true;
  /** Market data the simulated fill was modelled on. Absent on records created before this field existed. */
  marketDataSource?: MarketSource;
}

export interface Position {
  mint: string;
  symbol: string;
  quantity: number;
  /** Total SOL spent to acquire the open quantity, INCLUDING fees. */
  costBasisSol: number;
  /** costBasisSol / quantity (fee-inclusive break-even price). */
  avgEntryPriceSol: number;
  /** Average execution price excluding fees. */
  avgFillPriceSol: number;
  openedAt: number;
  updatedAt: number;
  entryLiquiditySol: number | null;
  peakPriceSol: number;
  lastPriceSol: number;
  lastPriceAt: number;
  realizedPnlSol: number;
}

export interface PositionView extends Position {
  markPriceSol: number;
  marketValueSol: number;
  /** Estimated SOL received if the whole position were sold now (after impact + fees). */
  liquidationValueSol: number;
  unrealizedPnlSol: number;
  unrealizedPnlPct: number;
  priceStale: boolean;
  valuationMethod: 'amm-liquidation' | 'spot-minus-fees' | 'last-known-price';
}

export interface PortfolioSummary {
  mode: 'PAPER';
  virtual: true;
  startingBalanceSol: number;
  cashSol: number;
  positionsValueSol: number;
  equitySol: number;
  realizedPnlSol: number;
  /** Unrealized P&L of positions with a FRESH price only. */
  unrealizedPnlSol: number;
  /** Unrealized P&L of positions without a fresh price, at their last known price (not live). */
  staleUnrealizedPnlSol: number;
  /** Open positions without a fresh price (valued at last known price; cannot be exited until priced). */
  stalePositions: number;
  /** Value included in equity for those stale positions. */
  staleValueSol: number;
  /** equity - starting balance (includes stale positions at last known value). */
  totalPnlSol: number;
  totalReturnPct: number;
  feesPaidSol: number;
  peakEquitySol: number;
  drawdownPct: number;
  dayStartEquitySol: number;
  dailyPnlSol: number;
  openPositions: number;
  exposureSol: number;
  asOf: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
  cash: number;
  positionsValue: number;
  realized: number;
  unrealized: number;
}

export interface StrategyDecision {
  id: string;
  ts: number;
  mint: string;
  symbol: string;
  action: DecisionAction;
  reasons: string[];
  strategyChecks: Check[];
  riskChecks: Check[];
  snapshot: MarketObservation | null;
  outcome: string;
  orderId: string | null;
}

export type AuditLevel = 'info' | 'warn' | 'error';
export interface AuditEntry {
  id: string;
  ts: number;
  level: AuditLevel;
  type: string;
  message: string;
  data: unknown;
}

export type ProviderState = 'starting' | 'ok' | 'degraded' | 'down';

/** Health of one token-discovery source (e.g. a DexScreener list endpoint). */
export interface DiscoverySourceStatus {
  source: string;
  lastOkAt: number | null;
  lastCount: number | null;
  lastError: string | null;
}

export interface ProviderHealth {
  provider: MarketSource;
  simulated: boolean;
  state: ProviderState;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextPollAt: number | null;
  trackedTokens: number;
  rejectedObservations: number;
  rateLimitedUntil: number | null;
  detail: string;
  /** Effective interval between provider polls (respects the provider's minimum). */
  pollIntervalMs: number;
  discovery: DiscoverySourceStatus[];
  /** Non-fatal problems from the last poll (e.g. one chunk failed). */
  warnings: string[];
}

export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  at: number | null;
}

/** A period with no scheduler ticks: no market data, exit checks or recording happened. */
export interface MonitoringGap {
  from: number;
  to: number;
  openPositions: number;
  botRunning: boolean;
}

export interface BotStatus {
  mode: 'PAPER';
  realTradingEnabled: false;
  running: boolean;
  killSwitch: KillSwitchState;
  lastTickAt: number | null;
  ticks: number;
  pollIntervalMs: number;
  buyBlockedReasons: string[];
  /** Recent unmonitored periods since the API started (most recent last, max 20). */
  monitoringGaps: MonitoringGap[];
}

export interface TokenView extends MarketObservation {
  ageMs: number;
  stale: boolean;
  held: boolean;
  /** False when a simulated fill cannot be modelled responsibly (observation-only). */
  tradable: boolean;
  /** Why the token is observation-only (empty when tradable). */
  blockers: string[];
  /** Current deterministic entry evaluation (independent of whether the bot is running). */
  entrySignal: 'BUY' | 'SKIP';
  entryFailures: string[];
  /** Whether the provider still refreshes this token on every poll. */
  tracked: boolean;
  /** When this application fetched the observation (same as observedAt). */
  fetchedAt: number;
  /** Timestamp reported by the data source for this data, if it provides one (DexScreener does not: null). */
  sourceTimestamp: number | null;
  /** When price/liquidity/volume/txn fields last changed between fetches (re-fetching identical data does not count). */
  lastChangedAt: number | null;
}

/** Outcome of the bot's most recent trading cycle. */
export interface BotCycleStats {
  at: number;
  candidates: number;
  buySignals: number;
  /** BUY signals not submitted because of portfolio-level blocks, with reasons. */
  suppressed: string[];
  submitted: number;
  filled: number;
  /** Rejected orders in this cycle, with reasons. */
  rejected: string[];
  exitsEvaluated: number;
  sellSignals: number;
}

/** Funnel from observed tokens to simulated orders, for the dashboard. */
export interface StrategyPipelineSummary {
  at: number;
  provider: MarketSource;
  simulated: boolean;
  botRunning: boolean;
  killSwitchActive: boolean;
  buyBlockedReasons: string[];
  observed: number;
  tracked: number;
  fresh: number;
  tradable: number;
  entrySignals: number;
  /** Count of candidates by the FIRST failing entry rule (evaluation order). */
  firstFailure: Record<string, number>;
  lastCycle: BotCycleStats | null;
  /** Plain-language explanation of why no simulated order is being submitted. */
  noOrderReason: string | null;
}

export interface RecordedSnapshotStats {
  source: MarketSource;
  observations: number;
  tokens: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface BacktestTrade {
  mint: string;
  symbol: string;
  entryAt: number;
  exitAt: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  returnPct: number;
  exitReason: string;
}

export interface BacktestReport {
  dataset: 'synthetic' | 'recorded';
  dataSource: string;
  disclaimer: string;
  frames: number;
  startTs: number | null;
  endTs: number | null;
  startingBalanceSol: number;
  endingEquitySol: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  tradeCount: number;
  winRatePct: number | null;
  profitFactor: number | null;
  avgTradeReturnPct: number | null;
  feesPaidSol: number;
  /** Same data and rules with trading fee, slippage buffer and network fee set to zero (AMM impact retained). */
  zeroCostNetReturnPct: number | null;
  rejectedOrders: number;
  cancelledOrders: number;
  trades: BacktestTrade[];
  equityCurve: { ts: number; equity: number }[];
  assumptions: string[];
  limitations: string[];
}
