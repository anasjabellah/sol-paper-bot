import { randomBytes } from 'node:crypto';

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

let lastIdTs = 0;
let idSeq = 0;

/**
 * Time-sortable unique id: base36 timestamp + sequence + random suffix.
 * Lexicographic order matches creation order within a process.
 */
export function newId(now: number = Date.now()): string {
  if (now === lastIdTs) idSeq += 1;
  else {
    lastIdTs = now;
    idSeq = 0;
  }
  return `${now.toString(36).padStart(9, '0')}${idSeq.toString(36).padStart(3, '0')}${randomBytes(5).toString('hex')}`;
}

/** Minimal promise-based mutex used to serialize order execution and SQLite transactions. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function round(n: number, decimals = 9): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
