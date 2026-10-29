'use client';

import { useCallback } from 'react';
import type { StrategyPipelineSummary } from '@spb/shared';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { fmtAgo } from '@/lib/format';
import { Badge, Card, ErrorNote, Loading } from './ui';

const RULE_LABELS: Record<string, string> = {
  data_fresh: 'Stale data',
  price_available: 'No price',
  min_liquidity: 'Liquidity unavailable / too low',
  min_txns_5m: 'Too few 5m transactions',
  min_volume_5m: 'Too little 5m volume',
  momentum_5m: '5m momentum out of range',
  buy_sell_ratio: 'Buy/sell ratio too low',
  token_age: 'Token age out of range / unknown',
  max_price_impact: 'Price impact / spread too high',
  not_already_held: 'Already held',
  cooldown: 'In post-exit cooldown',
};

/** Funnel from observed tokens to simulated orders, with the reason nothing was ordered. */
export function PipelinePanel() {
  const p = usePolling(useCallback(() => api.get<StrategyPipelineSummary>('/strategy/pipeline'), []), 5000);
  const d = p.data;
  const failures = d ? Object.entries(d.firstFailure).sort((a, b) => b[1] - a[1]) : [];
  const maxCount = failures.length ? failures[0][1] : 1;

  return (
    <Card title="Strategy pipeline" id="pipeline" right={d && <Badge tone={d.simulated ? 'sim' : 'accent'}>{d.provider}</Badge>}>
      {!d ? (
        p.error ? <ErrorNote message={p.error.message} /> : <Loading />
      ) : (
        <div className="space-y-3 text-sm">
          <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Candidate funnel">
            {[
              ['Observed', d.observed],
              ['Tracked', d.tracked],
              ['Fresh', d.fresh],
              ['Tradable', d.tradable],
              ['BUY signals', d.entrySignals],
              ['Orders (last cycle)', d.lastCycle ? d.lastCycle.submitted : 0],
            ].map(([label, n]) => (
              <li key={label} className="rounded border border-line bg-panel-2 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
                <div className="num text-lg font-semibold">{n}</div>
              </li>
            ))}
          </ol>

          {d.noOrderReason ? (
            <p role="status" className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              <span className="font-semibold">Why no order: </span>
              {d.noOrderReason}
            </p>
          ) : (
            <p role="status" className="rounded border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">
              Simulated orders were filled in the last bot cycle.
            </p>
          )}

          {failures.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">First failing entry rule (per candidate)</div>
              <ul className="space-y-1">
                {failures.map(([rule, n]) => (
                  <li key={rule} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="truncate text-muted" title={rule}>
                        {RULE_LABELS[rule] ?? rule} <span className="font-mono text-faint">({rule})</span>
                      </div>
                      <div className="mt-0.5 h-1.5 rounded bg-panel-2">
                        <div className="h-1.5 rounded bg-warn/70" style={{ width: `${(n / maxCount) * 100}%` }} />
                      </div>
                    </div>
                    <span className="num font-semibold">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {d.lastCycle && (
            <p className="text-xs text-faint">
              Last bot cycle {fmtAgo(d.lastCycle.at)}: {d.lastCycle.candidates} candidates, {d.lastCycle.buySignals} BUY signals,{' '}
              {d.lastCycle.suppressed.length} suppressed, {d.lastCycle.submitted} submitted ({d.lastCycle.filled} filled, {d.lastCycle.rejected.length} rejected);{' '}
              {d.lastCycle.exitsEvaluated} positions checked for exit.
            </p>
          )}
          <p className="text-[11px] text-faint">
            Rules are applied as configured; nothing is relaxed to force trades. Tokens no longer refreshed by the provider count as observed but not tracked.
          </p>
        </div>
      )}
    </Card>
  );
}
