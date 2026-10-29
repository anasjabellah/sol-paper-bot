'use client';

import { useCallback, useState } from 'react';
import type { BacktestReport, RecordedSnapshotStats } from '@spb/shared';
import { usePolling } from '@/lib/usePolling';
import { api, ApiError } from '@/lib/api';
import { fmtAgo, fmtNum, fmtPct, fmtSol, pnlClass } from '@/lib/format';
import { Badge, Button, Card, ErrorNote } from './ui';

export function BacktestPanel() {
  const [dataset, setDataset] = useState<'synthetic' | 'recorded'>('synthetic');
  const [source, setSource] = useState<'dexscreener' | 'mock'>('dexscreener');
  const recordings = usePolling(useCallback(() => api.get<{ items: RecordedSnapshotStats[] }>('/market/recordings'), []), 60_000);
  const rec = recordings.data?.items.find((r) => r.source === source);
  const [seed, setSeed] = useState('7');
  const [steps, setSteps] = useState('2000');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = dataset === 'synthetic' ? { dataset, seed: Number(seed), steps: Number(steps) } : { dataset, source };
      setReport(await api.post<BacktestReport>('/backtest', body));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const input = 'num mt-0.5 w-full rounded-md border border-line bg-bg px-2 py-1 text-sm';
  return (
    <Card title="Backtest" id="backtest" right={<Badge tone="warn">offline</Badge>}>
      <form onSubmit={run} className="space-y-2">
        <p className="text-xs text-faint">Replays the current strategy & risk settings with next-bar fills (no look-ahead). Separate from live paper trading.</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="col-span-3 block text-xs text-muted sm:col-span-1 xl:col-span-3 2xl:col-span-1">
            Dataset
            <select className={`${input} font-sans`} value={dataset} onChange={(e) => setDataset(e.target.value as 'synthetic' | 'recorded')}>
              <option value="synthetic">Synthetic</option>
              <option value="recorded">Recorded</option>
            </select>
          </label>
          {dataset === 'recorded' && (
            <label className="col-span-3 block text-xs text-muted sm:col-span-2 xl:col-span-3 2xl:col-span-2">
              Recorded source
              <select className={input + ' font-sans'} value={source} onChange={(e) => setSource(e.target.value as 'dexscreener' | 'mock')}>
                <option value="dexscreener">Real (DexScreener snapshots)</option>
                <option value="mock">Mock (simulated snapshots)</option>
              </select>
            </label>
          )}
          {dataset === 'synthetic' && (
            <>
              <label className="block text-xs text-muted">
                Seed
                <input className={input} type="number" min="0" value={seed} onChange={(e) => setSeed(e.target.value)} />
              </label>
              <label className="col-span-2 block text-xs text-muted sm:col-span-1 xl:col-span-2 2xl:col-span-1">
                Steps (5s)
                <input className={input} type="number" min="10" max="20000" value={steps} onChange={(e) => setSteps(e.target.value)} />
              </label>
            </>
          )}
        </div>
        {dataset === 'recorded' && (
          <p className="text-xs text-muted">
            {rec
              ? `${rec.observations.toLocaleString()} ${source} snapshots · ${rec.tokens} tokens · since ${fmtAgo(rec.firstAt)}`
              : `No ${source} snapshots recorded yet. Run the API with this provider to record them — history is never fabricated.`}
          </p>
        )}
        <Button type="submit" tone="primary" className="w-full" disabled={busy}>
          {busy ? 'Running…' : 'Run backtest'}
        </Button>
      </form>
      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}
      {report && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="rounded border border-warn/40 bg-warn/10 p-2 text-xs text-warn">{report.disclaimer}</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 num">
            <dt className="font-sans text-muted">Net return</dt>
            <dd className={`text-right ${pnlClass(report.netReturnPct)}`}>{fmtPct(report.netReturnPct)}</dd>
            <dt className="font-sans text-muted">Zero-cost return</dt>
            <dd className={"text-right " + pnlClass(report.zeroCostNetReturnPct)} title="Same data and rules without fees / slippage buffer">
              {fmtPct(report.zeroCostNetReturnPct)}
            </dd>
            <dt className="font-sans text-muted">Max drawdown</dt>
            <dd className="text-right">{report.maxDrawdownPct.toFixed(2)}%</dd>
            <dt className="font-sans text-muted">Trades</dt>
            <dd className="text-right">{report.tradeCount}</dd>
            <dt className="font-sans text-muted">Win rate</dt>
            <dd className="text-right">{report.winRatePct == null ? 'n/a' : `${report.winRatePct.toFixed(1)}%`}</dd>
            <dt className="font-sans text-muted">Profit factor</dt>
            <dd className="text-right">{report.profitFactor == null ? 'n/a' : fmtNum(report.profitFactor, 2)}</dd>
            <dt className="font-sans text-muted">Avg trade</dt>
            <dd className="text-right">{fmtPct(report.avgTradeReturnPct)}</dd>
            <dt className="font-sans text-muted">Fees paid</dt>
            <dd className="text-right">{fmtSol(report.feesPaidSol, 5)} SOL</dd>
            <dt className="font-sans text-muted">Frames</dt>
            <dd className="text-right">{report.frames}</dd>
          </dl>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Assumptions & limitations</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {[...report.assumptions, ...report.limitations].map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </Card>
  );
}
