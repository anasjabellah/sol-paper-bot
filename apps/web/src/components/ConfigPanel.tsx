'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RiskConfig, StrategyConfig } from '@spb/shared';
import { api, ApiError } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Button, Card, ErrorNote, Loading } from './ui';

type Field = { key: string; label: string; unit?: string; step?: string; kind?: 'bool' };

const STRATEGY_FIELDS: Field[] = [
  { key: 'orderSizeSol', label: 'Order size', unit: 'SOL', step: '0.01' },
  { key: 'minLiquiditySol', label: 'Min liquidity', unit: 'SOL', step: '1' },
  { key: 'minTxns5m', label: 'Min txns (5m)', step: '1' },
  { key: 'minVolume5mSol', label: 'Min volume (5m)', unit: 'SOL', step: '0.5' },
  { key: 'minPriceChange5mPct', label: 'Min 5m change', unit: '%', step: '0.5' },
  { key: 'maxPriceChange5mPct', label: 'Max 5m change', unit: '%', step: '1' },
  { key: 'minBuySellRatio', label: 'Min buy/sell ratio', step: '0.05' },
  { key: 'maxPriceImpactPct', label: 'Max price impact', unit: '%', step: '0.1' },
  { key: 'requireTokenAge', label: 'Require token age', kind: 'bool' },
  { key: 'minTokenAgeMinutes', label: 'Min token age', unit: 'min', step: '1' },
  { key: 'maxTokenAgeMinutes', label: 'Max token age', unit: 'min', step: '10' },
  { key: 'takeProfitPct', label: 'Take profit', unit: '%', step: '1' },
  { key: 'stopLossPct', label: 'Stop loss', unit: '%', step: '1' },
  { key: 'trailingStopPct', label: 'Trailing stop', unit: '%', step: '1' },
  { key: 'maxHoldMinutes', label: 'Max hold', unit: 'min', step: '1' },
  { key: 'exitOnLiquidityDropPct', label: 'Exit on liquidity drop', unit: '%', step: '1' },
];

const RISK_FIELDS: Field[] = [
  { key: 'maxOrderSizeSol', label: 'Max order size', unit: 'SOL', step: '0.1' },
  { key: 'maxExposurePerTokenSol', label: 'Max exposure / token', unit: 'SOL', step: '0.1' },
  { key: 'maxConcurrentPositions', label: 'Max concurrent positions', step: '1' },
  { key: 'maxDailyLossSol', label: 'Daily loss limit', unit: 'SOL', step: '0.1' },
  { key: 'maxDrawdownPct', label: 'Max drawdown', unit: '%', step: '1' },
  { key: 'autoKillOnDrawdown', label: 'Auto emergency stop on drawdown', kind: 'bool' },
  { key: 'cooldownMinutesAfterExit', label: 'Cooldown after exit', unit: 'min', step: '1' },
  { key: 'duplicateWindowMs', label: 'Duplicate-order window', unit: 'ms', step: '1000' },
  { key: 'maxDataAgeMs', label: 'Max data age (stale)', unit: 'ms', step: '1000' },
];

type Cfg = Record<string, number | boolean>;

export function ConfigPanel({ kind }: { kind: 'strategy' | 'risk' }) {
  const path = kind === 'strategy' ? '/strategy/config' : '/risk/config';
  const fields = kind === 'strategy' ? STRATEGY_FIELDS : RISK_FIELDS;
  const remote = usePolling(useCallback(() => api.get<{ config: StrategyConfig | RiskConfig; defaults: Cfg }>(path), [path]), 30_000);
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const current = remote.data?.config as Cfg | undefined;
  useEffect(() => {
    if (current && draft === null) setDraft(Object.fromEntries(Object.entries(current).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)])));
  }, [current, draft]);

  const dirty = !!current && !!draft && fields.some((f) => String(draft[f.key]) !== String(current[f.key]));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft || !current) return;
    const patch: Cfg = {};
    for (const f of fields) {
      const v = draft[f.key];
      if (String(v) === String(current[f.key])) continue;
      patch[f.key] = f.kind === 'bool' ? Boolean(v) : Number(v);
    }
    try {
      await api.put(path, patch);
      setErrors([]);
      setSaved(true);
      setDraft(null);
      remote.refresh();
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setErrors((err.details as { path: string; message: string }[]).map((d) => `${d.path || 'config'}: ${d.message}`));
      } else setErrors([err instanceof Error ? err.message : String(err)]);
    }
  };

  return (
    <Card title={kind === 'strategy' ? 'Strategy parameters' : 'Risk limits'} id={`cfg-${kind}`}>
      {!draft ? (
        remote.error ? (
          <ErrorNote message={remote.error.message} />
        ) : (
          <Loading />
        )
      ) : (
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {fields.map((f) =>
              f.kind === 'bool' ? (
                <label key={f.key} className="flex items-center gap-2 text-xs text-muted sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--color-accent)]"
                    checked={Boolean(draft[f.key])}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })}
                  />
                  {f.label}
                </label>
              ) : (
                <label key={f.key} className="block text-xs text-muted">
                  {f.label}
                  {f.unit && <span className="text-faint"> ({f.unit})</span>}
                  <input
                    type="number"
                    step={f.step ?? 'any'}
                    inputMode="decimal"
                    className="num mt-0.5 w-full rounded-md border border-line bg-bg px-2 py-1 text-sm text-ink"
                    value={String(draft[f.key] ?? '')}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                </label>
              ),
            )}
          </div>
          {errors.length > 0 && <ErrorNote message={errors.join(' · ')} />}
          <div className="flex items-center gap-2">
            <Button type="submit" tone="primary" disabled={!dirty}>
              Save
            </Button>
            <Button disabled={!dirty} onClick={() => setDraft(null)}>
              Revert
            </Button>
            <span aria-live="polite" className="text-xs text-up">
              {saved ? 'Saved' : ''}
            </span>
          </div>
        </form>
      )}
    </Card>
  );
}
