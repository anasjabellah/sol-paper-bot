'use client';

import type { EquityPoint } from '@spb/shared';
import { fmtSol, fmtTime } from '@/lib/format';
import { Empty } from './ui';

const W = 640;
const H = 200;
const PAD = { l: 8, r: 8, t: 12, b: 18 };

/** Lightweight SVG equity curve (no chart dependency). */
export function EquityChart({ points, baseline }: { points: EquityPoint[]; baseline: number }) {
  if (points.length < 2) {
    return <Empty>Not enough data yet — the chart appears after a few equity snapshots (every ~15s).</Empty>;
  }
  const values = points.map((p) => p.equity);
  let min = Math.min(...values, baseline);
  let max = Math.max(...values, baseline);
  if (max - min < 1e-9) {
    min -= 0.01;
    max += 0.01;
  }
  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const x = (ts: number) => PAD.l + ((ts - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${H - PAD.b} L${x(t0).toFixed(1)},${H - PAD.b} Z`;
  const last = points[points.length - 1].equity;
  const up = last >= baseline;
  const color = up ? 'var(--color-up)' : 'var(--color-down)';

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-48 w-full"
        role="img"
        aria-label={`Virtual equity from ${fmtSol(points[0].equity)} to ${fmtSol(last)} SOL`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(baseline)} y2={y(baseline)} stroke="var(--color-faint)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={area} fill="url(#eq-fill)" />
        <path d={line} fill="none" stroke={color} strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-faint num">
        <span>{fmtTime(t0)}</span>
        <span className="order-last w-full text-center sm:order-none sm:w-auto">
          range {fmtSol(min)} – {fmtSol(max)} · dashed = starting balance
        </span>
        <span>{fmtTime(t1)}</span>
      </figcaption>
    </figure>
  );
}
