'use client';

import { useCallback } from 'react';
import type { BotStatus, CostConfig, EquityPoint, PaperOrder, PortfolioSummary, PositionView, ProviderHealth, RiskConfig, TokenView } from '@spb/shared';
import { api, API_URL } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { fmtAgo, fmtSol } from '@/lib/format';
import { Badge, Card, ErrorNote, Loading } from './ui';
import { EquityChart } from './EquityChart';
import { MarketTable, PositionsTable, ProviderStatus, StatCards, TradesTable } from './Panels';
import { BotControls, ManualOrder, ProviderSelector } from './Controls';
import { ConfigPanel } from './ConfigPanel';
import { LogsPanel } from './LogsPanel';
import { BacktestPanel } from './BacktestPanel';
import { PipelinePanel } from './PipelinePanel';

interface StatusResponse {
  disclaimer: string;
  mode: 'PAPER';
  realTradingEnabled: false;
  providerSelectedBy: 'dashboard' | 'env' | 'injected';
  bot: BotStatus;
  market: ProviderHealth;
  risk: RiskConfig;
  costs: CostConfig;
}
interface TokensResponse {
  items: TokenView[];
  simulated: boolean;
  provider: string;
}

export function Dashboard() {
  const status = usePolling(useCallback(() => api.get<StatusResponse>('/status'), []), 3000);
  const portfolio = usePolling(useCallback(() => api.get<PortfolioSummary>('/portfolio'), []), 3000);
  const positions = usePolling(useCallback(() => api.get<{ items: PositionView[] }>('/portfolio/positions'), []), 3000);
  const tokens = usePolling(useCallback(() => api.get<TokensResponse>('/market/tokens'), []), 5000);
  const trades = usePolling(useCallback(() => api.get<{ items: PaperOrder[]; total: number }>('/trades?limit=25'), []), 5000);
  const equity = usePolling(useCallback(() => api.get<{ items: EquityPoint[] }>('/portfolio/equity?limit=720'), []), 15000);

  const refreshers = [status.refresh, portfolio.refresh, positions.refresh, trades.refresh, tokens.refresh] as const;
  const refreshAll = useCallback(() => refreshers.forEach((r) => r()), refreshers); // eslint-disable-line react-hooks/exhaustive-deps

  const apiDown = status.error?.code === 'NETWORK';

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-10">
      {/* Persistent simulation banner */}
      <div role="note" className="sticky top-0 z-20 -mx-4 mb-4 border-b border-sim/40 bg-[#1b1430]/95 px-4 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="sim">Paper mode</Badge>
            <span className="text-sm font-semibold text-ink">SIMULATION ONLY — virtual balances, no real transactions</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DataModeBadge health={status.data?.market} />
            {status.data?.bot.killSwitch.active && <Badge tone="down">Emergency stop active</Badge>}
          </div>
        </div>
      </div>

      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Solana Paper Trading Terminal</h1>
          <p className="text-sm text-muted">Deterministic momentum strategy · pump.fun ecosystem · all fills simulated</p>
        </div>
        <p className="text-xs text-faint num">API {API_URL}</p>
      </header>

      {apiDown && (
        <div className="mb-4">
          <ErrorNote message={`${status.error?.message} Start it with "npm run dev" from the repository root.`} />
        </div>
      )}

      <StatCards summary={portfolio.data} loading={portfolio.loading} error={portfolio.error?.message} />

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <Card
            title="Virtual equity"
            id="equity"
            right={portfolio.data && <span className="text-xs text-muted num">start {fmtSol(portfolio.data.startingBalanceSol)} SOL</span>}
          >
            {equity.loading ? <Loading /> : <EquityChart points={equity.data?.items ?? []} baseline={portfolio.data?.startingBalanceSol ?? 0} />}
          </Card>

          <Card title={`Open positions${positions.data ? ` (${positions.data.items.length})` : ''}`} id="positions">
            <PositionsTable positions={positions.data?.items} loading={positions.loading} error={positions.error?.message} />
          </Card>

          <PipelinePanel />

          <Card title="Market observations" id="market" right={tokens.data && <MarketBadge simulated={tokens.data.simulated} provider={tokens.data.provider} />}>
            <MarketTable tokens={tokens.data?.items} loading={tokens.loading} error={tokens.error?.message} />
          </Card>

          <Card title={`Recent simulated trades${trades.data ? ` (${trades.data.total})` : ''}`} id="trades">
            <TradesTable trades={trades.data?.items} loading={trades.loading} error={trades.error?.message} />
          </Card>

          <LogsPanel />
        </div>

        <aside className="min-w-0 space-y-4">
          <BotControls status={status.data?.bot} onChange={refreshAll} disabled={apiDown} />
          <Card title="Market data source" id="provider">
            <ProviderSelector health={status.data?.market} botRunning={status.data?.bot.running ?? false} disabled={apiDown} onChange={refreshAll} />
            <div className="mt-3 border-t border-line pt-3">
              <ProviderStatus health={status.data?.market} loading={status.loading} />
            </div>
          </Card>
          <ManualOrder tokens={tokens.data?.items ?? []} positions={positions.data?.items ?? []} onDone={refreshAll} costs={status.data?.costs} />
          <ConfigPanel kind="strategy" />
          <ConfigPanel kind="risk" />
          <BacktestPanel />
        </aside>
      </div>

      <footer className="mt-8 border-t border-line pt-4 text-xs text-faint">
        {status.data?.disclaimer ?? 'PAPER TRADING ONLY.'} Strategy results — simulated, backtested or otherwise — are not evidence of real-world profitability.
      </footer>
    </div>
  );
}

function MarketBadge({ simulated, provider }: { simulated: boolean; provider: string }) {
  return simulated ? <Badge tone="warn">Mock · simulated prices</Badge> : <Badge tone="accent">Real data · {provider} · read-only</Badge>;
}

/** Data mode exactly as confirmed by the API - never assumed by the UI. */
function DataModeBadge({ health }: { health?: ProviderHealth }) {
  if (!health) return <Badge tone="muted">Data mode unknown (API unreachable)</Badge>;
  if (health.simulated) {
    return (
      <Badge tone="warn" title="Prices are generated by the deterministic mock simulator">
        Data: MOCK · simulated market
      </Badge>
    );
  }
  const tone = health.state === 'ok' ? 'accent' : health.state === 'starting' ? 'muted' : 'down';
  const label =
    health.state === 'ok'
      ? `updated ${fmtAgo(health.lastSuccessAt)}`
      : health.state === 'starting'
        ? 'connecting…'
        : `${health.state} · last update ${fmtAgo(health.lastSuccessAt)}`;
  return (
    <Badge tone={tone} title="Real market data from the public DexScreener API (read-only). Trades remain simulated.">
      Data: REAL · DexScreener (read-only) · {label}
    </Badge>
  );
}
