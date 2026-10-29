import type { CostConfig, PortfolioSummary, Position, PositionView } from '@spb/shared';
import type { Db } from '../database/db';
import type { Repository } from '../database/repository';
import type { MarketDataService } from '../market/marketService';
import { observationExitReferencePriceSol, summarize, valuePosition, type AccountState } from '../paper/accounting';
import { Mutex, utcDayKey, type Clock } from '../lib/util';
import type { SettingsService } from './settingsService';

export interface PortfolioSnapshot {
  account: AccountState;
  positions: Position[];
  views: PositionView[];
  summary: PortfolioSummary;
}

/** Virtual account state, position valuation and equity tracking. */
export class PortfolioService {
  /** Serializes every mutation of account/positions (orders, mark-to-market, reset). */
  readonly lock = new Mutex();
  private lastEquitySnapshotAt = 0;

  constructor(
    private readonly repo: Repository,
    private readonly market: MarketDataService,
    private readonly settings: SettingsService,
    readonly costs: CostConfig,
    private readonly clock: Clock,
    private readonly defaultStartingBalanceSol: number,
    private readonly equitySnapshotEveryMs = 15_000,
  ) {}

  async getAccount(tx: Db = this.repo.db): Promise<AccountState> {
    const existing = await this.repo.getKv<AccountState>('account', tx);
    if (existing) return existing;
    return this.createAccount(this.defaultStartingBalanceSol, tx);
  }

  async createAccount(startingBalanceSol: number, tx: Db = this.repo.db): Promise<AccountState> {
    const now = this.clock();
    const account: AccountState = {
      startingBalanceSol,
      cashSol: startingBalanceSol,
      realizedPnlSol: 0,
      feesPaidSol: 0,
      peakEquitySol: startingBalanceSol,
      dayKey: utcDayKey(now),
      dayStartEquitySol: startingBalanceSol,
      createdAt: now,
    };
    await this.repo.setKv('account', account, tx);
    return account;
  }

  async snapshot(tx: Db = this.repo.db): Promise<PortfolioSnapshot> {
    const now = this.clock();
    const [account, positions] = await Promise.all([this.getAccount(tx), this.repo.listPositions(tx)]);
    const maxAge = this.settings.getRisk().maxDataAgeMs;
    const views = positions.map((p) => valuePosition(p, this.market.get(p.mint), now, maxAge, this.costs));
    return { account, positions, views, summary: summarize(account, views, now) };
  }

  /**
   * Periodic mark-to-market: refresh last/peak prices from fresh observations,
   * roll the UTC trading day, track peak equity and store an equity snapshot.
   */
  markToMarket(): Promise<PortfolioSummary> {
    return this.lock.run(() => this.markToMarketUnlocked());
  }

  private async markToMarketUnlocked(): Promise<PortfolioSummary> {
    const now = this.clock();
    const maxAge = this.settings.getRisk().maxDataAgeMs;
    const summary = await this.repo.db.transaction(async (tx) => {
      for (const p of await this.repo.listPositions(tx)) {
        const obs = this.market.get(p.mint);
        if (!obs || obs.priceSol == null || now - obs.observedAt > maxAge || obs.observedAt <= p.lastPriceAt) continue;
        // Last/peak price stay on the exit-reference basis (see PRICE CONVENTION in accounting.ts);
        // an observation no SELL could be modelled from does not move them.
        const ref = observationExitReferencePriceSol(obs);
        if (ref === null) continue;
        await this.repo.upsertPosition({ ...p, lastPriceSol: ref, lastPriceAt: obs.observedAt, peakPriceSol: Math.max(p.peakPriceSol, ref) }, tx);
      }
      const snap = await this.snapshot(tx);
      const account = { ...snap.account };
      const today = utcDayKey(now);
      if (account.dayKey !== today) {
        account.dayKey = today;
        account.dayStartEquitySol = snap.summary.equitySol;
      }
      account.peakEquitySol = Math.max(account.peakEquitySol, snap.summary.equitySol);
      await this.repo.setKv('account', account, tx);
      return summarize(account, snap.views, now);
    });

    if (now - this.lastEquitySnapshotAt >= this.equitySnapshotEveryMs) {
      this.lastEquitySnapshotAt = now;
      await this.repo.insertEquity({
        ts: now,
        equity: summary.equitySol,
        cash: summary.cashSol,
        positionsValue: summary.positionsValueSol,
        realized: summary.realizedPnlSol,
        unrealized: summary.unrealizedPnlSol,
      });
    }
    return summary;
  }

  async cooldowns(tx: Db = this.repo.db): Promise<Record<string, number>> {
    return (await this.repo.getKv<Record<string, number>>('cooldowns', tx)) ?? {};
  }
}
