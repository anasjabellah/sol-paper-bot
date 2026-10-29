import type { ReactNode } from 'react';

export function Card({
  title,
  right,
  children,
  className = '',
  id,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section aria-labelledby={id ? `${id}-title` : undefined} className={`min-w-0 rounded-lg border border-line bg-panel ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 id={id ? `${id}-title` : undefined} className="text-xs font-semibold uppercase tracking-wider text-muted">
          {title}
        </h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

type Tone = 'up' | 'down' | 'warn' | 'muted' | 'accent' | 'sim';
const toneClass: Record<Tone, string> = {
  up: 'border-up/40 bg-up/10 text-up',
  down: 'border-down/40 bg-down/10 text-down',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  muted: 'border-line bg-panel-2 text-muted',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  sim: 'border-sim/50 bg-sim/15 text-sim',
};

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${toneClass[tone]}`}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="space-y-2 py-2" aria-label={label}>
      <div className="h-3 w-2/3 animate-pulse rounded bg-panel-2" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-panel-2" />
      <div className="h-3 w-3/4 animate-pulse rounded bg-panel-2" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
      {message}
    </p>
  );
}

const btnTone: Record<'primary' | 'danger' | 'ghost' | 'success', string> = {
  primary: 'border-accent/50 bg-accent/15 text-accent hover:bg-accent/25',
  success: 'border-up/50 bg-up/15 text-up hover:bg-up/25',
  danger: 'border-down/60 bg-down/20 text-down hover:bg-down/30',
  ghost: 'border-line bg-panel-2 text-ink hover:bg-line',
};

export function Button({
  tone = 'ghost',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof btnTone }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${btnTone[tone]} ${className}`}
    />
  );
}

/** Horizontally scrollable table wrapper so wide tables never cause page-level scroll on phones. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4">{children}</div>;
}

export const th = 'whitespace-nowrap px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-faint';
export const td = 'whitespace-nowrap px-2 py-1.5';
