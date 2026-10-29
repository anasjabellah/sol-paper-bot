export const fmtSol = (n: number | null | undefined, d = 4) =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export const fmtSigned = (n: number | null | undefined, d = 4) =>
  n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${fmtSol(n, d)}`;

export const fmtPct = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`;

export const fmtPrice = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toExponential(4));

export const fmtQty = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 });

export const fmtNum = (n: number | null | undefined, d = 1) =>
  n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d });

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const fmtTime = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export const shortMint = (m: string) => (m.length > 14 ? `${m.slice(0, 5)}…${m.slice(-4)}` : m);

export const pnlClass = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');
