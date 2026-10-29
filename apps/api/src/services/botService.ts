import type { BotCycleStats, BotStatus, Check, MarketObservation, MonitoringGap, StrategyDecision } from '@spb/shared';
import type { Repository } from '../database/repository';
import type { AuditLogger } from '../logging/audit';
import type { MarketDataService } from '../market/marketService';
import { evaluateEntry, evaluateExit, type StrategyResult } from '../strategy/momentumStrategy';
import { portfolioBuyBlocks } from '../risk/riskManager';
import { estimateBuyTotalCostSol, poolFromObservation } from '../paper/accounting';
import { HttpError } from '../lib/errors';
import { errorMessage, newId, type Clock } from '../lib/util';
import type { OrderService } from './orderService';
import type { PortfolioService } from './portfolioService';
import type { SettingsService } from './settingsService';

/** Identical SKIP decisions for a token are persisted at most this often. */
const SKIP_LOG_INTERVAL_MS = 60_000;
const PRUNE_EVERY_TICKS = 200;
/** Gaps between ticks longer than this (or 6x the interval) are recorded as unmonitored periods. */
const MIN_MONITORING_GAP_MS = 60_000;

/**
 * Bot signal queued for next-observation fill (same timing model as the backtest engine).
 * Decision uses signalObs; the simulated fill uses a strictly newer observation.
 */
interface PendingSignal {
  mint: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  sizeSol?: number;
  fraction?: number;
  /** Observation that produced the signal (decision-time snapshot). */
  signalObs: MarketObservation;
  result: StrategyResult;
  decidedAt: number;
}

/**
 * The scheduler. Every tick it (1) refreshes market data, (2) fills signals queued on the
 * previous tick against the new observation (next-bar / no look-ahead, matching backtest),
 * (3) marks the paper portfolio to market and enforces portfolio-level risk, and (4) if the
 * bot is running, evaluates exits then entries and queues new signals (does not fill them
 * on the decision observation).
 * The bot always boots STOPPED; it must be started explicitly.
 */
export class BotService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickAt: number | null = null;
  private ticks = 0;
  private lastBuyBlocks: string[] = [];
  private lastCycle: BotCycleStats | null = null;
  private monitoringGaps: MonitoringGap[] = [];
  private readonly lastSkip = new Map<string, { key: string; ts: number }>();
  /** Signals decided on a prior tick; filled only after a newer observation arrives. */
  private pending: PendingSignal[] = [];

  constructor(
    private readonly repo: Repository,
    private readonly market: MarketDataService,
    private readonly portfolio: PortfolioService,
    private readonly orders: OrderService,
    private readonly settings: SettingsService,
    private readonly audit: AuditLogger,
    private readonly clock: Clock,
    private readonly pollIntervalMs: number,
    private readonly observationRetentionRows = 200_000,
  ) {}

  startScheduler(): void {
    if (this.timer) return;
    const loop = () => {
      void this.tick().finally(() => {
        if (this.timer) this.timer = setTimeout(loop, this.pollIntervalMs);
      });
    };
    this.timer = setTimeout(loop, 0);
  }

  stopScheduler(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Number of bot signals waiting for a newer observation before simulated fill. */
  pendingCount(): number {
    return this.pending.length;
  }

  async start(): Promise<BotStatus> {
    if (this.settings.getKillSwitch().active) {
      throw new HttpError(409, 'KILL_SWITCH_ACTIVE', 'Emergency stop is active. Reset it before starting the bot.');
    }
    if (!this.running) {
      this.running = true;
      await this.audit.info('bot.started', 'Paper trading bot started (simulation only)');
    }
    return this.status();
  }

  async stop(reason = 'manual stop'): Promise<BotStatus> {
    if (this.running) {
      this.running = false;
      // Drop queued BUYs so a stop cannot open new risk on the next tick; keep SELLs (risk-reducing).
      await this.cancelPendingBuys(`bot stopped: ${reason}`);
      await this.audit.info('bot.stopped', `Paper trading bot stopped: ${reason}`);
    }
    return this.status();
  }

  async emergencyStop(reason: string): Promise<BotStatus> {
    // Order matters: flip the in-memory flags first so no new order can slip through.
    this.running = false;
    await this.cancelPendingBuys(`emergency stop: ${reason}`);
    await this.settings.activateKillSwitch(reason);
    return this.status();
  }

  status(): BotStatus {
    return {
      mode: 'PAPER',
      realTradingEnabled: false,
      running: this.running,
      killSwitch: this.settings.getKillSwitch(),
      lastTickAt: this.lastTickAt,
      ticks: this.ticks,
      pollIntervalMs: this.pollIntervalMs,
      buyBlockedReasons: this.lastBuyBlocks,
      monitoringGaps: this.monitoringGaps,
    };
  }

  /**
   * One scheduler iteration. Safe to call directly (tests); overlapping calls are skipped.
   * Order matches the backtest engine: refresh → fill prior signals → mark-to-market → decide/queue.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const held = await this.repo.listPositions();
      await this.detectMonitoringGap(held.length);
      // Open positions and pending signals must stay refreshable.
      const pin = new Set<string>([...held.map((p) => p.mint), ...this.pending.map((p) => p.mint)]);
      this.market.provider.setPinnedMints?.([...pin]);
      await this.market.refresh();

      const fillStats = await this.fillPending();
      const summary = await this.portfolio.markToMarket();
      const risk = this.settings.getRisk();

      if (risk.autoKillOnDrawdown && !this.settings.getKillSwitch().active && summary.drawdownPct >= risk.maxDrawdownPct) {
        await this.emergencyStop(`max drawdown ${summary.drawdownPct.toFixed(2)}% >= ${risk.maxDrawdownPct}% (automatic)`);
      }
      this.lastBuyBlocks = portfolioBuyBlocks(summary, risk, this.settings.getKillSwitch().active);

      if (this.running && !this.settings.getKillSwitch().active) await this.trade(fillStats);
      else {
        this.lastCycle = {
          at: this.clock(),
          candidates: 0,
          buySignals: 0,
          suppressed: [],
          submitted: fillStats.submitted,
          filled: fillStats.filled,
          rejected: fillStats.rejected,
          exitsEvaluated: 0,
          sellSignals: 0,
        };
      }

      this.ticks++;
      this.lastTickAt = this.clock();
      if (this.ticks % PRUNE_EVERY_TICKS === 0) await this.prune();
    } catch (err) {
      await this.audit.error('bot.tick_failed', `Bot tick failed: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A tick far later than scheduled means nothing was monitored in between (machine sleep,
   * suspended process, blocked event loop): no market data, no exit checks, no recording.
   * Record it so performance reports can account for the unmonitored period.
   */
  private async detectMonitoringGap(openPositions: number) {
    const now = this.clock();
    const threshold = Math.max(MIN_MONITORING_GAP_MS, 6 * this.pollIntervalMs);
    if (this.lastTickAt !== null && now - this.lastTickAt > threshold) {
      const gap: MonitoringGap = { from: this.lastTickAt, to: now, openPositions, botRunning: this.running };
      this.monitoringGaps = [...this.monitoringGaps.slice(-19), gap];
      await this.audit.warn(
        'bot.monitoring_gap',
        `No monitoring for ${Math.round((now - this.lastTickAt) / 60_000)} min (${openPositions} open position(s) unwatched; bot ${this.running ? 'running' : 'stopped'})`,
        gap,
      );
    }
  }

  /** Stats from the most recent trading cycle (null until the bot has traded once). */
  cycleStats(): BotCycleStats | null {
    return this.lastCycle;
  }

  /**
   * Fill signals queued on a previous tick against the current market snapshot.
   * Requires a strictly newer observation than the signal (next-bar). Missing or
   * unmodelable tokens cancel the signal (same as backtest cancelledOrders).
   */
  private async fillPending(): Promise<{ submitted: number; filled: number; rejected: string[]; cancelled: number }> {
    const stats = { submitted: 0, filled: 0, rejected: [] as string[], cancelled: 0 };
    if (this.pending.length === 0) return stats;

    const remaining: PendingSignal[] = [];
    // Snapshot and clear so we never re-enter the same signal mid-loop.
    const batch = this.pending;
    this.pending = [];

    for (const signal of batch) {
      // Match backtest frame membership: not in this successful poll ⇒ cancel (cache alone is not enough).
      if (!this.market.wasInLastPoll(signal.mint)) {
        stats.cancelled++;
        await this.record(
          signal.mint,
          signal.symbol,
          signal.signalObs,
          signal.result,
          [],
          'next-observation fill cancelled: token absent from market snapshot',
          null,
        );
        continue;
      }
      const obs = this.market.get(signal.mint);
      if (!obs) {
        stats.cancelled++;
        await this.record(
          signal.mint,
          signal.symbol,
          signal.signalObs,
          signal.result,
          [],
          'next-observation fill cancelled: token absent from market snapshot',
          null,
        );
        continue;
      }
      if (obs.observedAt <= signal.signalObs.observedAt) {
        // Same or older bar: keep waiting (live poll returned the same fetch timestamp).
        remaining.push(signal);
        continue;
      }
      const pool = poolFromObservation(obs);
      if (!pool.ok) {
        stats.cancelled++;
        await this.record(
          signal.mint,
          signal.symbol,
          signal.signalObs,
          signal.result,
          [],
          `next-observation fill cancelled: ${pool.reason}`,
          null,
        );
        continue;
      }

      const clientOrderId = `bot:${signal.side}:${signal.mint}:${signal.signalObs.observedAt}`;
      try {
        const { order, replay } = await this.orders.submit({
          clientOrderId,
          mint: signal.mint,
          side: signal.side,
          type: 'MARKET',
          origin: 'bot',
          sizeSol: signal.side === 'BUY' ? signal.sizeSol : undefined,
          fraction: signal.side === 'SELL' ? (signal.fraction ?? 1) : undefined,
        });
        if (replay) continue;
        stats.submitted++;
        if (order.status === 'FILLED') stats.filled++;
        else stats.rejected.push(signal.symbol + ': ' + (order.rejectReason ?? 'rejected'));
        const outcome =
          order.status === 'FILLED'
            ? `simulated order ${order.id} filled on next observation (signal at ${signal.signalObs.observedAt}, fill at ${obs.observedAt})`
            : `order rejected on next observation: ${order.rejectReason}`;
        // Decision snapshot is the signal-time observation; fill prices come from the newer obs via the order.
        await this.record(signal.mint, signal.symbol, signal.signalObs, signal.result, order.riskChecks, outcome, order.id);
      } catch (err) {
        stats.rejected.push(`${signal.symbol}: order error: ${errorMessage(err)}`);
        await this.record(
          signal.mint,
          signal.symbol,
          signal.signalObs,
          signal.result,
          [],
          `next-observation order error: ${errorMessage(err)}`,
          null,
        );
        await this.audit.error('bot.order_error', `Bot order failed for ${signal.symbol}: ${errorMessage(err)}`);
      }
    }

    this.pending = remaining;
    return stats;
  }

  private async cancelPendingBuys(reason: string): Promise<void> {
    if (this.pending.length === 0) return;
    const keep: PendingSignal[] = [];
    for (const signal of this.pending) {
      if (signal.side === 'BUY') {
        await this.record(
          signal.mint,
          signal.symbol,
          signal.signalObs,
          signal.result,
          [],
          `queued BUY cancelled (${reason})`,
          null,
        );
      } else keep.push(signal);
    }
    this.pending = keep;
  }

  private async trade(fillStats: { submitted: number; filled: number; rejected: string[] }) {
    const now = this.clock();
    const cycle: BotCycleStats = {
      at: now,
      candidates: 0,
      buySignals: 0,
      suppressed: [],
      submitted: fillStats.submitted,
      filled: fillStats.filled,
      rejected: [...fillStats.rejected],
      exitsEvaluated: 0,
      sellSignals: 0,
    };
    this.lastCycle = cycle;
    const strategy = this.settings.getStrategy();
    const risk = this.settings.getRisk();

    const pendingMints = new Set(this.pending.map((p) => p.mint));

    // Exits first: they reduce risk and free capacity.
    const { positions } = await this.portfolio.snapshot();
    for (const p of positions) {
      if (!this.running || this.settings.getKillSwitch().active) return;
      if (pendingMints.has(p.mint)) continue; // already queued (typically a SELL)
      const obs = this.market.get(p.mint);
      const r = evaluateExit(p, obs, { now, strategy, risk, costs: this.portfolio.costs });
      cycle.exitsEvaluated++;
      if (r.action === 'SELL') {
        cycle.sellSignals++;
        await this.queue(p.mint, p.symbol, obs, r, cycle);
      } else {
        await this.record(p.mint, p.symbol, obs ?? null, r, [], 'no action', null);
      }
    }

    const held = new Set(positions.map((p) => p.mint));
    const cooldowns = await this.portfolio.cooldowns();
    // Only tokens present in this poll/frame (not merely retained in the cache) — matches backtest.
    const candidates = this.market
      .all()
      .filter((o) => !held.has(o.mint) && !pendingMints.has(o.mint) && this.market.wasInLastPoll(o.mint))
      .sort((a, b) => (b.volume5mSol ?? -1) - (a.volume5mSol ?? -1));
    cycle.candidates = candidates.length;

    // Reserve capacity for already-queued BUYs (backtest decrements slots when queuing).
    let buySlots = risk.maxConcurrentPositions - positions.length - this.pending.filter((p) => p.side === 'BUY').length;

    for (const obs of candidates) {
      if (!this.running || this.settings.getKillSwitch().active) return;
      const r = evaluateEntry(obs, {
        now,
        strategy,
        risk,
        costs: this.portfolio.costs,
        held: false,
        lastExitAt: cooldowns[obs.mint] ?? null,
      });
      if (r.action === 'BUY') {
        cycle.buySignals++;
        if (buySlots <= 0) {
          cycle.suppressed.push(`${obs.symbol}: max concurrent positions (including queued buys)`);
          await this.record(obs.mint, obs.symbol, obs, { ...r, action: 'SKIP' }, [], 'signal suppressed: no free position slots', null);
          continue;
        }
        const { summary } = await this.portfolio.snapshot();
        const blocks = portfolioBuyBlocks(summary, risk, false);
        if (blocks.length) {
          cycle.suppressed.push(obs.symbol + ': ' + blocks.join('; '));
          await this.record(obs.mint, obs.symbol, obs, { ...r, action: 'SKIP' }, [], `signal suppressed: ${blocks.join('; ')}`, null);
          continue;
        }
        // Don't queue an order the risk gate is certain to reject at fill time either.
        const neededSol = estimateBuyTotalCostSol(r.sizeSol ?? 0, this.portfolio.costs);
        if (summary.cashSol < neededSol) {
          const reason = `insufficient virtual cash (needs ${neededSol.toFixed(6)} SOL, virtual cash ${summary.cashSol.toFixed(6)} SOL)`;
          cycle.suppressed.push(`${obs.symbol}: ${reason}`);
          await this.record(obs.mint, obs.symbol, obs, { ...r, action: 'SKIP' }, [], `signal suppressed: ${reason}`, null);
          continue;
        }
        await this.queue(obs.mint, obs.symbol, obs, r, cycle);
        buySlots--;
        pendingMints.add(obs.mint);
      } else {
        await this.record(obs.mint, obs.symbol, obs, r, [], 'no action', null);
      }
    }
  }

  private async queue(
    mint: string,
    symbol: string,
    obs: MarketObservation | undefined,
    r: StrategyResult,
    _cycle: BotCycleStats,
  ) {
    if (!obs) {
      await this.record(mint, symbol, null, { ...r, action: 'SKIP' }, [], 'cannot queue: no observation', null);
      return;
    }
    this.pending.push({
      mint,
      symbol,
      side: r.action as 'BUY' | 'SELL',
      sizeSol: r.sizeSol,
      fraction: r.fraction,
      signalObs: obs,
      result: r,
      decidedAt: this.clock(),
    });
    await this.audit.info(
      'bot.signal_queued',
      `Queued ${r.action} ${symbol} for next-observation fill (paper/backtest aligned)`,
      { mint, side: r.action, signalObservedAt: obs.observedAt },
    );
  }

  private async record(
    mint: string,
    symbol: string,
    snapshot: MarketObservation | null,
    r: StrategyResult,
    riskChecks: Check[],
    outcome: string,
    orderId: string | null,
  ) {
    const now = this.clock();
    if (r.action === 'SKIP') {
      const key = r.reasons.map((x) => x.split(':')[0]).join('|') + outcome;
      const prev = this.lastSkip.get(mint);
      if (prev && prev.key === key && now - prev.ts < SKIP_LOG_INTERVAL_MS) return;
      this.lastSkip.set(mint, { key, ts: now });
    }
    const decision: StrategyDecision = {
      id: newId(now),
      ts: now,
      mint,
      symbol,
      action: r.action,
      reasons: r.reasons,
      strategyChecks: r.checks,
      riskChecks,
      snapshot,
      outcome,
      orderId,
    };
    await this.repo.insertDecision(decision);
  }

  private async prune() {
    await this.repo.prune('decisions', 5_000);
    await this.repo.prune('audit_log', 20_000);
    await this.repo.prune('observations', this.observationRetentionRows);
    await this.repo.pruneEquity(20_000);
    for (const [mint, v] of this.lastSkip) if (this.clock() - v.ts > 10 * SKIP_LOG_INTERVAL_MS) this.lastSkip.delete(mint);
  }
}
