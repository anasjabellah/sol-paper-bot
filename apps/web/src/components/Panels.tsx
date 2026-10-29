'use client';

import { useState } from 'react';
import type { PaperOrder, PortfolioSummary, PositionView, ProviderHealth, TokenView } from '@spb/shared';
import { fmtAgo, fmtNum, fmtPct, fmtPrice, fmtQty, fmtSigned, fmtSol, fmtTime, pnlClass, shortMint } from '@/lib/format';
import { Badge, Empty, ErrorNote, Loading, TableWrap, td, th } from './ui';

export function StatCards({ summary: s, loading, error }: { summary?: PortfolioSummary; loading: boolean; error?: string }) {
  if (loading && !s) return <Loading label="Loading portfolio" />;
  if (!s) return error ? <ErrorNote message={`Portfolio unavailable: ${error}`} /> : null;
  const stats: { label: string; value: string; sub?: string; cls?: string }[] = [
    { label: 'Total equity', value: `${fmtSol(s.equitySol)}`, sub: `${fmtPct(s.totalReturnPct)} since start`, cls: pnlClass(s.totalPnlSol) },
    { label: 'Virtual cash', value: fmtSol(s.cashSol), sub: `exposure ${fmtSol(s.exposureSol)}` },
    { label: 'Realized P&L', value: fmtSigned(s.realizedPnlSol), cls: pnlClass(s.realizedPnlSol), sub: `fees ${fmtSol(s.feesPaidSol, 5)}` },
    {
      label: 'Unrealized P&L (live)',
      value: fmtSigned(s.unrealizedPnlSol),
      cls: pnlClass(s.unrealizedPnlSol),
      sub:
        s.stalePositions > 0
          ? `excl. ${s.stalePositions} stale: ${fmtSigned(s.staleUnrealizedPnlSol)} at last known price`
          : 'at est. liquidation value',
    },
    { label: 'Today', value: fmtSigned(s.dailyPnlSol), cls: pnlClass(s.dailyPnlSol), sub: 'UTC day' },
    { label: 'Drawdown', value: `${s.drawdownPct.toFixed(2)}%`, sub: `peak ${fmtSol(s.peakEquitySol)}`, cls: s.drawdownPct > 0 ? 'text-warn' : 'text-ink' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {stats.map((x) => (
        <div key={x.label} className="min-w-0 rounded-lg border border-line bg-panel px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{x.label}</div>
          <div className={`num mt-0.5 truncate text-lg font-semibold ${x.cls ?? 'text-ink'}`}>
            {x.value} <span className="text-xs font-normal text-faint">SOL</span>
          </div>
          {x.sub && <div className="truncate text-xs text-muted num">{x.sub}</div>}
        </div>
      ))}
    </div>
  );
}

export function PositionsTable({ positions, loading, error }: { positions?: PositionView[]; loading: boolean; error?: string }) {
  if (loading && !positions) return <Loading />;
  if (error && !positions) return <ErrorNote message={error} />;
  if (!positions?.length) return <Empty>No open positions.</Empty>;
  return (
    <TableWrap>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={th}>Token</th>
            <th className={`${th} text-right`}>Qty</th>
            <th className={`${th} text-right`}>Avg entry*</th>
            <th className={`${th} text-right`}>Mark</th>
            <th className={`${th} text-right`}>Cost</th>
            <th className={`${th} text-right`}>Liq. value</th>
            <th className={`${th} text-right`}>Unrealized</th>
            <th className={th}>Opened</th>
          </tr>
        </thead>
        <tbody className="num">
          {positions.map((p) => (
            <tr key={p.mint} className="border-t border-line">
              <td className={td}>
                <div className="flex items-center gap-1.5 font-sans">
                  <span className="font-medium">{p.symbol}</span>
                  {p.priceStale && (
                    <Badge
                      tone="warn"
                      title={`No fresh price. Valued at the last known price from ${fmtTime(p.lastPriceAt)}; exits cannot be evaluated until a fresh price arrives.`}
                    >
                      {p.valuationMethod === 'last-known-price' ? 'no live price' : 'stale'}
                    </Badge>
                  )}
                </div>
                <div className="text-[11px] text-faint">{shortMint(p.mint)}</div>
              </td>
              <td className={`${td} text-right`}>{fmtQty(p.quantity)}</td>
              <td className={`${td} text-right`}>{fmtPrice(p.avgEntryPriceSol)}</td>
              <td className={`${td} text-right`}>
                {fmtPrice(p.markPriceSol)}
                {p.priceStale && <div className="font-sans text-[11px] text-warn">last known · {fmtAgo(p.lastPriceAt)}</div>}
              </td>
              <td className={`${td} text-right`}>{fmtSol(p.costBasisSol)}</td>
              <td className={`${td} text-right`}>{fmtSol(p.liquidationValueSol)}</td>
              <td className={`${td} text-right ${pnlClass(p.unrealizedPnlSol)}`}>
                {fmtSigned(p.unrealizedPnlSol)} <span className="text-[11px]">({fmtPct(p.unrealizedPnlPct, 1)})</span>
              </td>
              <td className={`${td} text-muted`}>{fmtAgo(p.openedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-faint">* Fee-inclusive break-even price. Liquidation value = modelled proceeds of selling everything now, after impact and fees.</p>
      {positions.some((p) => p.valuationMethod === 'last-known-price') && (
        <p className="mt-1 text-[11px] text-warn">
          &quot;No live price&quot; positions have no current market data (e.g. mock tokens from an earlier simulation run). They are held at their last known price
          minus exit costs, kept in equity to avoid a false drawdown, excluded from live unrealized P&amp;L, and cannot be exited until priced again. Reset the paper
          account to clear them.
        </p>
      )}
    </TableWrap>
  );
}

export function TradesTable({ trades, loading, error }: { trades?: PaperOrder[]; loading: boolean; error?: string }) {
  if (loading && !trades) return <Loading />;
  if (error && !trades) return <ErrorNote message={error} />;
  if (!trades?.length) return <Empty>No simulated trades yet. Start the bot or place a manual paper order.</Empty>;
  return (
    <TableWrap>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={th}>Time</th>
            <th className={th}>Side</th>
            <th className={th}>Token</th>
            <th className={`${th} text-right`}>Qty</th>
            <th className={`${th} text-right`}>Fill price</th>
            <th className={`${th} text-right`}>Impact</th>
            <th className={`${th} text-right`}>Fees</th>
            <th className={`${th} text-right`}>Cash Δ</th>
            <th className={`${th} text-right`}>Realized</th>
            <th className={th}>Origin · data</th>
          </tr>
        </thead>
        <tbody className="num">
          {trades.map((o) => (
            <tr key={o.id} className="border-t border-line">
              <td className={`${td} text-muted`}>{fmtTime(o.createdAt)}</td>
              <td className={td}>
                <Badge tone={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</Badge>
              </td>
              <td className={`${td} font-sans`}>{o.symbol}</td>
              <td className={`${td} text-right`}>{fmtQty(o.fill?.quantity)}</td>
              <td className={`${td} text-right`}>{fmtPrice(o.fill?.priceSol)}</td>
              <td className={`${td} text-right text-muted`}>{o.fill ? `${o.fill.priceImpactPct.toFixed(2)}%` : '—'}</td>
              <td className={`${td} text-right text-muted`}>{o.fill ? fmtSol(o.fill.tradingFeeSol + o.fill.networkFeeSol, 5) : '—'}</td>
              <td className={`${td} text-right ${pnlClass(o.fill?.cashDeltaSol)}`}>{fmtSigned(o.fill?.cashDeltaSol)}</td>
              <td className={`${td} text-right ${pnlClass(o.fill?.realizedPnlSol)}`}>{o.fill?.realizedPnlSol == null ? '—' : fmtSigned(o.fill.realizedPnlSol)}</td>
              <td className={td}>
                <div className="flex gap-1">
                  <Badge tone={o.origin === 'bot' ? 'accent' : 'muted'}>{o.origin}</Badge>
                  <DataSourceBadge order={o} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export function MarketTable({ tokens, loading, error }: { tokens?: TokenView[]; loading: boolean; error?: string }) {
  const [onlyTradable, setOnlyTradable] = useState(false);
  if (loading && !tokens) return <Loading />;
  if (error && !tokens) return <ErrorNote message={error} />;
  if (!tokens?.length) return <Empty>No market observations yet. Waiting for the data provider…</Empty>;
  const tradableCount = tokens.filter((t) => t.tradable).length;
  const shown = onlyTradable ? tokens.filter((t) => t.tradable) : tokens;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {tokens.length} observed · <span className="text-up">{tradableCount} tradable</span> ·{' '}
          <span className="text-warn">{tokens.length - tradableCount} observation-only</span>
        </span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={onlyTradable} onChange={(e) => setOnlyTradable(e.target.checked)} />
          Tradable only
        </label>
      </div>
      <TableWrap>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={th}>Token</th>
              <th className={`${th} text-right`}>Price (SOL)</th>
              <th className={`${th} text-right`}>5m Δ</th>
              <th className={`${th} text-right`}>Liquidity</th>
              <th className={`${th} text-right`}>Vol 5m</th>
              <th className={`${th} text-right`}>Buys/Sells 5m</th>
              <th className={`${th} text-right`}>Pair age</th>
              <th className={th}>Freshness</th>
              <th className={th}>Simulated fills</th>
              <th className={th}>Strategy</th>
            </tr>
          </thead>
          <tbody className="num">
            {shown.map((t) => (
              <tr key={t.mint} className="border-t border-line align-top">
                <td className={td}>
                  <div className="flex items-center gap-1.5 font-sans">
                    {t.url ? (
                      <a href={t.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
                        {t.symbol}
                      </a>
                    ) : (
                      <span className="font-medium">{t.symbol}</span>
                    )}
                    {t.held && <Badge tone="accent">held</Badge>}
                    {t.simulated && <Badge tone="sim">sim</Badge>}
                  </div>
                  <div className="text-[11px] text-faint" title={t.mint}>
                    <span className="select-all">{shortMint(t.mint)}</span> {t.dexId ? `· ${t.dexId}` : ''}
                  </div>
                </td>
                <td className={`${td} text-right`}>{fmtPrice(t.priceSol)}</td>
                <td className={`${td} text-right ${pnlClass(t.priceChange5mPct)}`}>{fmtPct(t.priceChange5mPct, 1)}</td>
                <td className={`${td} text-right`}>
                  {t.quoteReserveSol == null ? <span className="text-faint">n/a</span> : `${fmtNum(t.quoteReserveSol)} SOL`}
                  {t.liquidityUsd != null && <div className="text-[11px] text-faint">${fmtNum(t.liquidityUsd, 0)}</div>}
                </td>
                <td className={`${td} text-right`}>{t.volume5mSol == null ? <span className="text-faint">n/a</span> : `${fmtNum(t.volume5mSol)} SOL`}</td>
                <td className={`${td} text-right`}>
                  {t.buys5m == null || t.sells5m == null ? <span className="text-faint">n/a</span> : `${t.buys5m}/${t.sells5m}`}
                </td>
                <td className={`${td} text-right text-muted`}>{t.pairCreatedAt ? fmtAgo(t.pairCreatedAt).replace(' ago', '') : 'n/a'}</td>
                <td className={td} title="Fetched = when this app last received the data. DexScreener reports no per-record market timestamp.">
                  {!t.tracked ? (
                    <Badge tone="down">not refreshed · {Math.round(t.ageMs / 1000)}s</Badge>
                  ) : t.stale ? (
                    <Badge tone="warn">stale · {Math.round(t.ageMs / 1000)}s</Badge>
                  ) : (
                    <Badge tone="up">fetched {Math.round(t.ageMs / 1000)}s ago</Badge>
                  )}
                  {t.lastChangedAt != null && t.fetchedAt - t.lastChangedAt >= 60_000 && (
                    <div className="mt-0.5 font-sans text-[11px] text-warn">data unchanged {fmtAgo(t.lastChangedAt).replace(' ago', '')}</div>
                  )}
                </td>
                <td className={`${td} whitespace-normal`}>
                  {t.tradable ? (
                    <Badge tone="up">tradable</Badge>
                  ) : (
                    <div className="min-w-[180px] max-w-[260px] whitespace-normal">
                      <Badge tone="warn">observation-only</Badge>
                      <div className="mt-0.5 font-sans text-[11px] text-muted">{t.blockers.join('; ')}</div>
                    </div>
                  )}
                </td>
                <td className={`${td} whitespace-normal`}>
                  {t.entrySignal === 'BUY' ? (
                    <Badge tone="up">entry signal</Badge>
                  ) : (
                    <div className="min-w-[180px] max-w-[260px] whitespace-normal" title={t.entryFailures.join('\n')}>
                      <span className="font-sans text-[11px] text-muted">
                        {t.entryFailures[0] ?? 'no signal'}
                        {t.entryFailures.length > 1 && <span className="text-faint"> (+{t.entryFailures.length - 1} more)</span>}
                      </span>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-faint">
          &quot;n/a&quot; means the provider did not supply the value — it is never treated as zero. Observation-only tokens cannot be paper-traded because a fill price
          cannot be modelled responsibly (e.g. pump.fun bonding-curve pairs have no reserve data on DexScreener). Strategy column shows the first failed entry rule (hover
          for all).
        </p>
      </TableWrap>
    </>
  );
}

export function ProviderStatus({ health: h, loading }: { health?: ProviderHealth; loading: boolean }) {
  if (loading && !h) return <Loading />;
  if (!h) return <Empty>Unavailable</Empty>;
  const tone = h.state === 'ok' ? 'up' : h.state === 'degraded' ? 'warn' : h.state === 'down' ? 'down' : 'muted';
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted">Active provider</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{h.provider}</span>
          {h.simulated ? <Badge tone="sim">simulated data</Badge> : <Badge tone="accent">real data · read-only</Badge>}
        </dd>
        <dt className="text-muted">State</dt>
        <dd>
          <Badge tone={tone}>{h.state}</Badge>
        </dd>
        <dt className="text-muted">Last success</dt>
        <dd className="num">
          {fmtAgo(h.lastSuccessAt)} {h.lastSuccessAt && <span className="text-faint">({fmtTime(h.lastSuccessAt)})</span>}
        </dd>
        <dt className="text-muted">Poll interval</dt>
        <dd className="num">{h.pollIntervalMs / 1000}s</dd>
        <dt className="text-muted">Tracked</dt>
        <dd className="num">{h.trackedTokens} tokens</dd>
        <dt className="text-muted">Rejected obs.</dt>
        <dd className="num">{h.rejectedObservations}</dd>
        {h.consecutiveFailures > 0 && (
          <>
            <dt className="text-muted">Failures</dt>
            <dd className="num text-down">{h.consecutiveFailures} in a row</dd>
          </>
        )}
        {h.rateLimitedUntil && (
          <>
            <dt className="text-muted">Rate limited</dt>
            <dd className="num text-warn">until {fmtTime(h.rateLimitedUntil)}</dd>
          </>
        )}
        {h.lastError && (
          <>
            <dt className="text-muted">Last error</dt>
            <dd className="break-words text-down">{h.lastError}</dd>
          </>
        )}
      </dl>
      {h.discovery.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Discovery sources</div>
          <ul className="space-y-0.5 text-xs">
            {h.discovery.map((d) => (
              <li key={d.source} className="flex flex-wrap items-baseline gap-x-2">
                <span className={d.lastError ? 'text-down' : d.lastOkAt ? 'text-up' : 'text-faint'}>{d.lastError ? '✗' : d.lastOkAt ? '✓' : '·'}</span>
                <span className="font-mono">{d.source}</span>
                <span className="text-muted">{d.lastError ? d.lastError : d.lastCount != null ? `${d.lastCount} tokens · ${fmtAgo(d.lastOkAt)}` : 'pending'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {h.warnings.length > 0 && (
        <ul className="space-y-0.5 rounded border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
          {h.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-faint">{h.detail}</p>
    </div>
  );
}

/** Which market data priced a simulated fill (inferred from the mint for legacy records). */
export function DataSourceBadge({ order }: { order: PaperOrder }) {
  // Type-only shared imports keep zod out of the browser bundle; mock mints carry a 'mock_' prefix.
  const src = order.marketDataSource ?? (order.mint.startsWith('mock_') ? 'mock' : 'dexscreener');
  return src === 'mock' ? <Badge tone="sim">mock data</Badge> : <Badge tone="accent">real data</Badge>;
}
