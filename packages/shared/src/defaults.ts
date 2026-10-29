import type { RiskConfig, StrategyConfig } from './schemas';

/**
 * Conservative baseline defaults. These are starting points for experimentation,
 * NOT a claim of profitability.
 */
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  minLiquiditySol: 50,
  minTxns5m: 20,
  minVolume5mSol: 5,
  minPriceChange5mPct: 3,
  maxPriceChange5mPct: 40,
  minBuySellRatio: 1.1,
  requireTokenAge: true,
  minTokenAgeMinutes: 5,
  maxTokenAgeMinutes: 1440,
  maxPriceImpactPct: 3,
  orderSizeSol: 0.25,
  takeProfitPct: 25,
  stopLossPct: 12,
  trailingStopPct: 10,
  maxHoldMinutes: 60,
  exitOnLiquidityDropPct: 40,
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxOrderSizeSol: 1,
  maxExposurePerTokenSol: 1,
  maxConcurrentPositions: 3,
  maxDailyLossSol: 1.5,
  maxDrawdownPct: 25,
  maxDataAgeMs: 30_000,
  duplicateWindowMs: 15_000,
  cooldownMinutesAfterExit: 30,
  autoKillOnDrawdown: true,
};
