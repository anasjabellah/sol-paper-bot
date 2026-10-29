'use client';

import { useMemo, useState } from 'react';
import type { BotStatus, CostConfig, PaperOrder, PositionView, ProviderHealth, TokenView } from '@spb/shared';
import { api, ApiError } from '@/lib/api';
import { fmtAgo, fmtPrice, fmtSigned, fmtSol, fmtQty } from '@/lib/format';
import { Badge, Button, Card, ErrorNote, Loading } from './ui';

export function BotControls({ status, onChange, disabled }: { status?: BotStatus; onChange: () => void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const call = async (path: string, body?: unknown, okText?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(path, body);
      if (okText) setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const kill = status?.killSwitch;
  return (
    <Card
      title="Bot control"
      id="bot"
      right={status && (kill?.active ? <Badge tone="down">halted</Badge> : status.running ? <Badge tone="up">running</Badge> : <Badge>stopped</Badge>)}
    >
      {!status ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Button tone="success" disabled={busy || disabled || status.running || kill?.active} onClick={() => call('/bot/start', undefined, 'Bot started (simulation).')}>
              ▶ Start
            </Button>
            <Button disabled={busy || disabled || !status.running} onClick={() => call('/bot/stop', undefined, 'Bot stopped.')}>
              ■ Stop
            </Button>
          </div>
          <Button
            tone="danger"
            className="w-full py-2.5 text-base font-bold"
            disabled={busy || disabled || kill?.active}
            onClick={() => call('/bot/emergency-stop', { reason: 'dashboard emergency stop' }, 'EMERGENCY STOP engaged. All new simulated orders are blocked.')}
            aria-describedby="kill-help"
          >
            ⛔ EMERGENCY STOP
          </Button>
          <p id="kill-help" className="text-xs text-faint">
            Immediately stops the bot and blocks every new simulated order until manually reset.
          </p>
          {kill?.active && (
            <div className="rounded border border-down/40 bg-down/10 p-2 text-sm">
              <div className="font-semibold text-down">Kill switch active</div>
              <div className="text-muted">
                {kill.reason} · {fmtAgo(kill.at)}
              </div>
              <Button
                className="mt-2"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Reset the emergency stop? The bot will remain stopped until you start it.')) {
                    void call('/bot/reset-kill-switch', { confirm: 'RESET' }, 'Kill switch reset. Bot remains stopped.');
                  }
                }}
              >
                Reset kill switch
              </Button>
            </div>
          )}
          {status.buyBlockedReasons.length > 0 && !kill?.active && (
            <div className="rounded border border-warn/40 bg-warn/10 p-2 text-xs text-warn">New buys blocked: {status.buyBlockedReasons.join('; ')}</div>
          )}
          <dl className="grid grid-cols-2 gap-1 text-xs text-muted">
            <dt>Last tick</dt>
            <dd className="num text-right">{fmtAgo(status.lastTickAt)}</dd>
            <dt>Ticks</dt>
            <dd className="num text-right">{status.ticks}</dd>
            <dt>Interval</dt>
            <dd className="num text-right">{status.pollIntervalMs / 1000}s</dd>
            <dt>Real trading</dt>
            <dd className="text-right font-semibold text-down">disabled (not implemented)</dd>
          </dl>
          <div aria-live="polite">{msg && (msg.ok ? <p className="text-sm text-up">{msg.text}</p> : <ErrorNote message={msg.text} />)}</div>
          <ResetAccount disabled={busy || disabled || status.running} onDone={onChange} />
        </div>
      )}
    </Card>
  );
}

const PROVIDERS: { id: 'mock' | 'dexscreener'; label: string; hint: string }[] = [
  { id: 'mock', label: 'MOCK', hint: 'Deterministic simulated market (offline)' },
  { id: 'dexscreener', label: 'DEXSCREENER', hint: 'Real Solana market data, read-only public API' },
];

/** Select the read-only market-data source. The active value always comes from the API. */
export function ProviderSelector({
  health,
  botRunning,
  disabled,
  onChange,
}: {
  health?: ProviderHealth;
  botRunning: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = health?.provider;

  const select = async (id: 'mock' | 'dexscreener') => {
    if (id === active) return;
    setBusy(true);
    setError(null);
    try {
      await api.put('/market/provider', { provider: id });
    } catch (e) {
      if (e instanceof ApiError) {
        const positions = (e.details as { positions?: { symbol: string }[] } | undefined)?.positions;
        setError(positions?.length ? `${e.message} (${positions.map((p) => p.symbol).join(', ')})` : e.message);
      } else setError(String(e));
    } finally {
      setBusy(false);
      onChange();
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Market data provider">
        {PROVIDERS.map((p) => (
          <Button
            key={p.id}
            role="radio"
            aria-checked={active === p.id}
            title={p.hint}
            tone={active === p.id ? (p.id === 'mock' ? 'primary' : 'success') : 'ghost'}
            disabled={busy || disabled || !health || botRunning}
            onClick={() => void select(p.id)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-faint">
        {botRunning
          ? 'Stop the bot to change the data source.'
          : 'Changes where market observations come from. Orders remain simulated in PAPER mode either way.'}
      </p>
      <div aria-live="polite">{error && <ErrorNote message={error} />}</div>
    </div>
  );
}

function ResetAccount({ disabled, onDone }: { disabled?: boolean; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-faint hover:text-muted">Reset paper account…</summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted">Deletes all simulated orders, positions and equity history (audit log is kept). Bot must be stopped.</p>
        <Button
          disabled={disabled}
          onClick={async () => {
            const input = window.prompt('Starting virtual balance in SOL:', '10');
            if (input === null) return;
            const n = Number(input);
            if (!Number.isFinite(n) || n <= 0) {
              setErr('Enter a positive number');
              return;
            }
            try {
              await api.post('/portfolio/reset', { confirm: 'RESET', startingBalanceSol: n });
              setErr(null);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
            onDone();
          }}
        >
          Reset account
        </Button>
        {err && <ErrorNote message={err} />}
      </div>
    </details>
  );
}

export function ManualOrder({
  tokens,
  positions,
  onDone,
  costs,
}: {
  tokens: TokenView[];
  positions: PositionView[];
  onDone: () => void;
  costs?: CostConfig;
}) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [mint, setMint] = useState('');
  const [size, setSize] = useState('0.1');
  const [fraction, setFraction] = useState('100');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ order?: PaperOrder; error?: string } | null>(null);

  const options = useMemo(
    // Observation-only tokens (no usable reserves / stale) cannot be priced, so they are not offered.
    () => (side === 'BUY' ? tokens.filter((t) => t.tradable).map((t) => ({ mint: t.mint, label: `${t.symbol} · ${fmtPrice(t.priceSol)}` })) : positions.map((p) => ({ mint: p.mint, label: `${p.symbol} · ${fmtQty(p.quantity)}` }))),
    [side, tokens, positions],
  );
  const selected = options.some((o) => o.mint === mint) ? mint : (options[0]?.mint ?? '');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const clientOrderId = `manual-${crypto.randomUUID()}`;
    const body =
      side === 'BUY'
        ? { mode: 'PAPER', clientOrderId, mint: selected, side, type: 'MARKET', sizeSol: Number(size) }
        : { mode: 'PAPER', clientOrderId, mint: selected, side, type: 'MARKET', fraction: Number(fraction) / 100 };
    try {
      const r = await api.post<{ order: PaperOrder }>('/orders', body);
      setResult({ order: r.order });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setResult({ order: (err.body as { order: PaperOrder }).order });
      else if (err instanceof ApiError && Array.isArray(err.details))
        setResult({ error: `${err.message}: ${(err.details as { path: string; message: string }[]).map((d) => `${d.path} ${d.message}`).join(', ')}` });
      else setResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      onDone();
    }
  };

  const input = 'w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm num';
  return (
    <Card title="Manual paper order" id="manual" right={<Badge tone="sim">virtual</Badge>}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Order side">
          {(['BUY', 'SELL'] as const).map((s) => (
            <Button key={s} tone={side === s ? (s === 'BUY' ? 'success' : 'danger') : 'ghost'} role="radio" aria-checked={side === s} onClick={() => setSide(s)}>
              {s}
            </Button>
          ))}
        </div>
        <label className="block text-xs text-muted">
          Token
          <select className={`${input} mt-1 font-sans`} value={selected} onChange={(e) => setMint(e.target.value)} disabled={!options.length}>
            {options.length === 0 && <option value="">{side === 'BUY' ? 'No fresh tokens' : 'No open positions'}</option>}
            {options.map((o) => (
              <option key={o.mint} value={o.mint}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {side === 'BUY' ? (
          <label className="block text-xs text-muted">
            Size (SOL, before fees)
            <input className={`${input} mt-1`} type="number" min="0" step="0.01" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} required />
          </label>
        ) : (
          <label className="block text-xs text-muted">
            Sell % of position
            <input className={`${input} mt-1`} type="number" min="1" max="100" step="1" inputMode="numeric" value={fraction} onChange={(e) => setFraction(e.target.value)} required />
          </label>
        )}
        <Button type="submit" tone="primary" className="w-full" disabled={busy || !selected}>
          {busy ? 'Simulating…' : `Submit simulated ${side}`}
        </Button>
        {costs && (
          <p className="text-[11px] text-faint">
            Fill model: AMM price impact on observed reserves + {costs.slippageBufferBps} bps slippage buffer + {costs.tradingFeeBps} bps fee + {costs.networkFeeSol} SOL network fee.
            All-or-nothing.
          </p>
        )}
        <div aria-live="polite">
          {result?.error && <ErrorNote message={result.error} />}
          {result?.order &&
            (result.order.status === 'FILLED' ? (
              <p className="rounded border border-up/40 bg-up/10 p-2 text-sm text-up">
                Simulated {result.order.side} filled: {fmtQty(result.order.fill?.quantity)} @ {fmtPrice(result.order.fill?.priceSol)} · cash{' '}
                {fmtSigned(result.order.fill?.cashDeltaSol)} SOL
                {result.order.fill?.realizedPnlSol != null && ` · realized ${fmtSol(result.order.fill.realizedPnlSol)} SOL`}
              </p>
            ) : (
              <ErrorNote message={`Rejected: ${result.order.rejectReason}`} />
            ))}
        </div>
      </form>
    </Card>
  );
}
