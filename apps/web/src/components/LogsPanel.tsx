'use client';

import { useCallback, useState } from 'react';
import type { AuditEntry, PaperOrder, StrategyDecision } from '@spb/shared';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { fmtTime } from '@/lib/format';
import { Badge, Card, Empty, ErrorNote, Loading } from './ui';

type Tab = 'decisions' | 'signals' | 'rejected' | 'audit' | 'errors';
const TABS: { id: Tab; label: string }[] = [
  { id: 'signals', label: 'Signals' },
  { id: 'decisions', label: 'All decisions' },
  { id: 'audit', label: 'Activity' },
  { id: 'rejected', label: 'Rejected orders' },
  { id: 'errors', label: 'Errors' },
];

export function LogsPanel() {
  const [tab, setTab] = useState<Tab>('signals');
  const decisions = usePolling(useCallback(() => api.get<{ items: StrategyDecision[] }>('/logs/decisions?limit=60'), []), 5000);
  const audit = usePolling(useCallback(() => api.get<{ items: AuditEntry[] }>('/logs/audit?limit=60'), []), 5000);
  const errors = usePolling(useCallback(() => api.get<{ items: AuditEntry[] }>('/logs/audit?limit=60&level=error'), []), 10000);
  const rejected = usePolling(useCallback(() => api.get<{ items: PaperOrder[] }>('/orders?status=REJECTED&limit=50'), []), 10000);

  return (
    <Card
      title="Logs"
      id="logs"
      right={
        <div role="tablist" aria-label="Log type" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded px-2 py-1 text-xs ${tab === t.id ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-panel-2'}`}
            >
              {t.label}
              {t.id === 'errors' && (errors.data?.items.length ?? 0) > 0 && <span className="ml-1 text-down">({errors.data?.items.length})</span>}
            </button>
          ))}
        </div>
      }
    >
      <div role="tabpanel" className="max-h-[420px] overflow-y-auto">
        {tab === 'signals' && <DecisionList state={decisions} filter={(d) => d.action !== 'SKIP'} empty="No BUY/SELL signals yet." />}
        {tab === 'decisions' && <DecisionList state={decisions} empty="No decisions yet. Start the bot to evaluate tokens." />}
        {tab === 'audit' && <AuditList state={audit} empty="No activity yet." />}
        {tab === 'rejected' && <RejectedList state={rejected} />}
        {tab === 'errors' && <AuditList state={errors} empty="No errors recorded." />}
      </div>
    </Card>
  );
}

function DecisionList({
  state,
  filter,
  empty,
}: {
  state: { data?: { items: StrategyDecision[] }; loading: boolean; error: { message: string } | null };
  filter?: (d: StrategyDecision) => boolean;
  empty: string;
}) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorNote message={state.error.message} />;
  const items = (state.data?.items ?? []).filter(filter ?? (() => true));
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-line text-sm">
      {items.map((d) => (
        <li key={d.id} className="py-2">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="num text-xs text-faint">{fmtTime(d.ts)}</span>
              <Badge tone={d.action === 'BUY' ? 'up' : d.action === 'SELL' ? 'down' : 'muted'}>{d.action}</Badge>
              <span className="font-medium">{d.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{d.action === 'SKIP' ? d.reasons[0] : d.outcome}</span>
            </summary>
            <div className="mt-2 space-y-2 rounded bg-panel-2 p-2 text-xs">
              <div>
                <span className="text-faint">Reasons: </span>
                {d.reasons.join(' · ')}
              </div>
              <div>
                <span className="text-faint">Outcome: </span>
                {d.outcome}
              </div>
              <CheckList title="Strategy checks" checks={d.strategyChecks} />
              {d.riskChecks.length > 0 && <CheckList title="Risk checks" checks={d.riskChecks} />}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function RejectedList({ state }: { state: { data?: { items: PaperOrder[] }; loading: boolean; error: { message: string } | null } }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorNote message={state.error.message} />;
  const items = state.data?.items ?? [];
  if (!items.length) return <Empty>No rejected orders.</Empty>;
  return (
    <ul className="divide-y divide-line text-sm">
      {items.map((o) => (
        <li key={o.id} className="py-2">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="num text-xs text-faint">{fmtTime(o.createdAt)}</span>
              <Badge tone={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</Badge>
              <span className="font-medium">{o.symbol}</span>
              <Badge tone="muted">{o.origin}</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-down">{o.rejectReason}</span>
            </summary>
            <div className="mt-2 rounded bg-panel-2 p-2 text-xs">
              <CheckList title="Checks" checks={o.riskChecks} />
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function CheckList({ title, checks }: { title: string; checks: { name: string; passed: boolean; detail: string }[] }) {
  return (
    <div>
      <div className="mb-1 text-faint">{title}</div>
      <ul className="grid gap-0.5">
        {checks.map((c) => (
          <li key={c.name} className="flex gap-2">
            <span aria-label={c.passed ? 'passed' : 'failed'} className={c.passed ? 'text-up' : 'text-down'}>
              {c.passed ? '✓' : '✗'}
            </span>
            <span className="font-mono">{c.name}</span>
            <span className="text-muted">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AuditList({ state, empty }: { state: { data?: { items: AuditEntry[] }; loading: boolean; error: { message: string } | null }; empty: string }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorNote message={state.error.message} />;
  const items = state.data?.items ?? [];
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-line text-sm">
      {items.map((a) => (
        <li key={a.id} className="flex flex-wrap items-baseline gap-2 py-1.5">
          <span className="num text-xs text-faint">{fmtTime(a.ts)}</span>
          <Badge tone={a.level === 'error' ? 'down' : a.level === 'warn' ? 'warn' : 'muted'}>{a.level}</Badge>
          <span className="font-mono text-xs text-faint">{a.type}</span>
          <span className="min-w-0 flex-1 break-words">{a.message}</span>
        </li>
      ))}
    </ul>
  );
}
