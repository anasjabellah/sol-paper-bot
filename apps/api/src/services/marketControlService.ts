import { sourceOfMint, type MarketSource, type ProviderHealth } from '@spb/shared';
import type { Repository } from '../database/repository';
import type { AuditLogger } from '../logging/audit';
import type { MarketDataService } from '../market/marketService';
import type { MarketDataProvider } from '../market/provider';
import { HttpError } from '../lib/errors';
import { errorMessage } from '../lib/util';
import type { BotService } from './botService';

export type ProviderFactory = (name: MarketSource) => MarketDataProvider;

export const PROVIDER_KV_KEY = 'market_provider';

/**
 * Runtime selection of the READ-ONLY market-data provider. Switching only changes
 * where observations come from; the execution engine stays paper-only.
 *
 * Guards (so mock and real data can never be mixed in one portfolio):
 *  - the bot must be stopped;
 *  - no open position may belong to the other data source (it could no longer be
 *    priced or exited). Close those positions or reset the paper account first.
 */
export class MarketControlService {
  constructor(
    private readonly repo: Repository,
    private readonly market: MarketDataService,
    private readonly bot: BotService,
    private readonly audit: AuditLogger,
    private readonly factory: ProviderFactory,
  ) {}

  async select(name: MarketSource): Promise<ProviderHealth> {
    const previous = this.market.provider.name;
    if (name === previous) return this.market.health();
    if (this.bot.isRunning()) {
      throw new HttpError(409, 'BOT_RUNNING', 'Stop the bot before switching the market-data provider.');
    }
    const foreign = (await this.repo.listPositions()).filter((p) => sourceOfMint(p.mint) !== name);
    if (foreign.length > 0) {
      throw new HttpError(
        409,
        'POSITIONS_FROM_OTHER_SOURCE',
        `${foreign.length} open position(s) were opened on ${previous} data and could not be priced or exited on ${name} data. ` +
          'Sell them (Manual paper order → SELL 100%) or reset the paper account, then switch.',
        { positions: foreign.map((p) => ({ mint: p.mint, symbol: p.symbol })) },
      );
    }
    let provider: MarketDataProvider;
    try {
      provider = this.factory(name);
    } catch (err) {
      throw new HttpError(400, 'PROVIDER_CONFIG_ERROR', `Cannot create ${name} provider: ${errorMessage(err)}`);
    }
    await this.market.setProvider(provider);
    await this.repo.setKv(PROVIDER_KV_KEY, name);
    await this.audit.info('market.provider_changed', `Market data provider switched from ${previous} to ${name}`, {
      from: previous,
      to: name,
      simulated: provider.simulated,
    });
    // Fetch immediately in the background; the dashboard sees state "starting" until it lands.
    void this.market.refresh(true);
    return this.market.health();
  }
}
