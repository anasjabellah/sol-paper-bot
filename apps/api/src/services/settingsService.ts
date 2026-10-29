import {
  DEFAULT_RISK_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  RiskConfigSchema,
  StrategyConfigSchema,
  type KillSwitchState,
  type RiskConfig,
  type StrategyConfig,
} from '@spb/shared';
import type { Repository } from '../database/repository';
import type { AuditLogger } from '../logging/audit';
import { HttpError, formatZodIssues } from '../lib/errors';
import type { Clock } from '../lib/util';

/**
 * Strategy/risk configuration and the kill switch. Values are cached in memory
 * (authoritative for the running process) and persisted to the kv table.
 */
export class SettingsService {
  private strategy: StrategyConfig = DEFAULT_STRATEGY_CONFIG;
  private risk: RiskConfig = DEFAULT_RISK_CONFIG;
  private kill: KillSwitchState = { active: false, reason: null, at: null };

  constructor(
    private readonly repo: Repository,
    private readonly audit: AuditLogger,
    private readonly clock: Clock,
  ) {}

  async load(): Promise<void> {
    const s = await this.repo.getKv<unknown>('strategy_config');
    if (s !== undefined) {
      const r = StrategyConfigSchema.safeParse({ ...DEFAULT_STRATEGY_CONFIG, ...(s as object) });
      if (r.success) this.strategy = r.data;
      else await this.audit.warn('config.invalid_stored', 'Stored strategy config invalid; using defaults', formatZodIssues(r.error));
    }
    const k = await this.repo.getKv<unknown>('risk_config');
    if (k !== undefined) {
      const r = RiskConfigSchema.safeParse({ ...DEFAULT_RISK_CONFIG, ...(k as object) });
      if (r.success) this.risk = r.data;
      else await this.audit.warn('config.invalid_stored', 'Stored risk config invalid; using defaults', formatZodIssues(r.error));
    }
    const ks = await this.repo.getKv<KillSwitchState>('kill_switch');
    if (ks?.active) this.kill = ks;
  }

  getStrategy(): StrategyConfig {
    return this.strategy;
  }
  getRisk(): RiskConfig {
    return this.risk;
  }
  getKillSwitch(): KillSwitchState {
    return this.kill;
  }

  async updateStrategy(patch: Partial<StrategyConfig>): Promise<StrategyConfig> {
    const r = StrategyConfigSchema.safeParse({ ...this.strategy, ...patch });
    if (!r.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid strategy configuration', formatZodIssues(r.error));
    const before = this.strategy;
    this.strategy = r.data;
    await this.repo.setKv('strategy_config', r.data);
    await this.audit.info('config.strategy_updated', 'Strategy configuration updated', { before, after: r.data });
    return r.data;
  }

  async updateRisk(patch: Partial<RiskConfig>): Promise<RiskConfig> {
    const r = RiskConfigSchema.safeParse({ ...this.risk, ...patch });
    if (!r.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid risk configuration', formatZodIssues(r.error));
    const before = this.risk;
    this.risk = r.data;
    await this.repo.setKv('risk_config', r.data);
    await this.audit.info('config.risk_updated', 'Risk configuration updated', { before, after: r.data });
    return r.data;
  }

  /** Activates synchronously (in memory) BEFORE persisting, so it takes effect immediately. */
  async activateKillSwitch(reason: string): Promise<KillSwitchState> {
    this.kill = { active: true, reason, at: this.clock() };
    await this.repo.setKv('kill_switch', this.kill);
    await this.audit.error('risk.kill_switch_activated', `EMERGENCY STOP: ${reason}`, this.kill);
    return this.kill;
  }

  async resetKillSwitch(): Promise<KillSwitchState> {
    const prev = this.kill;
    this.kill = { active: false, reason: null, at: null };
    await this.repo.setKv('kill_switch', this.kill);
    await this.audit.warn('risk.kill_switch_reset', 'Emergency stop manually reset', { previous: prev });
    return this.kill;
  }
}
