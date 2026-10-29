/**
 * Offline backtest CLI.
 *   npm run backtest                                   synthetic data, defaults
 *   npm run backtest -- --seed 3 --steps 5000 --tokens 20
 *   npm run backtest -- --seeds 100-119 --steps 5000   aggregate over many synthetic seeds
 *   npm run backtest -- --recorded --source dexscreener replay REAL snapshots recorded by the API
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, type BacktestReport, type MarketSource } from '@spb/shared';
import { loadConfig } from '../config/env';
import { openDb } from '../database/db';
import { migrate } from '../database/migrations';
import { Repository } from '../database/repository';
import { runBacktest, type BacktestOptions } from './engine';
import { framesFromObservations, syntheticFrames } from './datasets';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '7' },
    seeds: { type: 'string' },
    steps: { type: 'string', default: '2000' },
    tokens: { type: 'string', default: '12' },
    recorded: { type: 'boolean', default: false },
    source: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const cfg = loadConfig();
const f = (n: number | null, d = 2) => (n === null ? 'n/a' : n.toFixed(d));
const base: Omit<BacktestOptions, 'dataset' | 'dataSource'> = {
  strategy: DEFAULT_STRATEGY_CONFIG,
  risk: DEFAULT_RISK_CONFIG,
  costs: cfg.costs,
  startingBalanceSol: cfg.startingBalanceSol,
};

function parseSeeds(spec: string): number[] {
  const m = /^(\d+)-(\d+)$/.exec(spec);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (b < a || b - a > 500) throw new Error('--seeds range must be ascending and at most 500 seeds');
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return spec.split(',').map((x) => Number(x.trim()));
}

function printReport(report: BacktestReport) {
  console.log(`\n=== BACKTEST (${report.dataset}) ===`);
  console.log(report.disclaimer);
  console.log(`source:            ${report.dataSource}`);
  console.log(`frames:            ${report.frames}`);
  console.log(`start -> end:      ${f(report.startingBalanceSol, 4)} -> ${f(report.endingEquitySol, 4)} SOL (virtual)`);
  console.log(`net return:        ${f(report.netReturnPct)}% (after fees & modelled slippage)`);
  console.log(`zero-cost return:  ${f(report.zeroCostNetReturnPct)}% (same rules, no fees/slippage buffer)`);
  console.log(`max drawdown:      ${f(report.maxDrawdownPct)}%`);
  console.log(`trades:            ${report.tradeCount}`);
  console.log(`win rate:          ${f(report.winRatePct)}%`);
  console.log(`profit factor:     ${f(report.profitFactor)}`);
  console.log(`avg trade return:  ${f(report.avgTradeReturnPct)}%`);
  console.log(`fees paid:         ${f(report.feesPaidSol, 6)} SOL`);
  console.log(`rejected/cancelled ${report.rejectedOrders}/${report.cancelledOrders}`);
  console.log('\nAssumptions:\n - ' + report.assumptions.join('\n - '));
  console.log('\nLimitations:\n - ' + report.limitations.join('\n - '));
}

if (values.recorded) {
  const source = (values.source ?? cfg.marketProvider) as MarketSource;
  if (source !== 'mock' && source !== 'dexscreener') throw new Error('--source must be mock or dexscreener');
  const db = await openDb(cfg.databaseUrl);
  await migrate(db);
  const obs = await new Repository(db).listObservations(source, cfg.observationRetentionRows);
  await db.close();
  const frames = framesFromObservations(obs, cfg.observationRecordIntervalMs || cfg.pollIntervalMs);
  if (frames.length < 10) {
    console.error(`Only ${frames.length} recorded ${source} frame(s) available. Run the API with this provider to record snapshots first.`);
    process.exit(1);
  }
  const report = runBacktest(frames, {
    ...base,
    dataset: 'recorded',
    recordedSource: source,
    dataSource: `recorded ${source} snapshots (${obs.length} observations)`,
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
} else if (values.seeds) {
  // Aggregate view across many seeds: a single seed is anecdotal.
  const rows: { seed: number; r: BacktestReport }[] = [];
  for (const seed of parseSeeds(values.seeds)) {
    const frames = await syntheticFrames(seed, Number(values.steps), Number(values.tokens));
    rows.push({ seed, r: runBacktest(frames, { ...base, dataset: 'synthetic', dataSource: `seed ${seed}` }) });
  }
  const net = rows.map((x) => x.r.netReturnPct).sort((a, b) => a - b);
  const zero = rows.map((x) => x.r.zeroCostNetReturnPct ?? Number.NaN);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const summary = {
    seeds: rows.length,
    steps: Number(values.steps),
    meanNetReturnPct: mean(net),
    medianNetReturnPct: net[Math.floor(net.length / 2)],
    profitableSeeds: net.filter((x) => x > 0).length,
    meanZeroCostReturnPct: mean(zero),
    meanTrades: mean(rows.map((x) => x.r.tradeCount)),
    meanFeesSol: mean(rows.map((x) => x.r.feesPaidSol)),
  };
  if (values.json) console.log(JSON.stringify({ summary, perSeed: rows.map((x) => ({ seed: x.seed, net: x.r.netReturnPct, zeroCost: x.r.zeroCostNetReturnPct, trades: x.r.tradeCount })) }, null, 2));
  else {
    console.log('SYNTHETIC multi-seed evaluation (mock simulator; says nothing about real markets)');
    for (const { seed, r } of rows) {
      console.log(`seed ${String(seed).padStart(4)}: net ${f(r.netReturnPct).padStart(7)}%  zero-cost ${f(r.zeroCostNetReturnPct).padStart(7)}%  trades ${r.tradeCount}`);
    }
    console.log(summary);
  }
} else {
  const frames = await syntheticFrames(Number(values.seed), Number(values.steps), Number(values.tokens));
  const report = runBacktest(frames, {
    ...base,
    dataset: 'synthetic',
    dataSource: `mock simulator seed=${values.seed} steps=${values.steps} tokens=${values.tokens}`,
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
