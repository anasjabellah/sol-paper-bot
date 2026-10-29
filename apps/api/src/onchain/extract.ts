/**
 * Locates raw event payloads in transaction logs and inner instructions.
 *
 *   - Logs: "Program data: <base64>" lines, attributed to the program at the top of the
 *     invoke stack ("Program <id> invoke [n]" / "Program <id> success|failed"). Data logged by any
 *     other program (including nested CPIs into other programs) is ignored.
 *   - Inner instructions (getTransaction only): self-CPI instructions of a watched program whose
 *     data starts with EVENT_IX_TAG (Anchor `emit_cpi!`).
 * Both carry the same `discriminator + borsh` bytes; merge() de-duplicates by payload hash.
 */
import { createHash } from 'node:crypto';
import { decodeBase58 } from './base58';
import { EVENT_IX_TAG } from './idl';

export interface RawEventCandidate {
  source: 'log' | 'cpi';
  programId: string;
  payload: Uint8Array;
}

export interface LogScan {
  candidates: RawEventCandidate[];
  /** The node truncated the logs ("Log truncated"); events after the cut are missing. */
  truncated: boolean;
  problems: string[];
}

const INVOKE_RE = /^Program (\w{32,44}) invoke \[(\d+)\]$/;
const EXIT_RE = /^Program (\w{32,44}) (success|failed)/;
const DATA_PREFIX = 'Program data: ';

export function scanLogs(logs: readonly string[], programIds: ReadonlySet<string>): LogScan {
  const stack: string[] = [];
  const out: LogScan = { candidates: [], truncated: false, problems: [] };
  for (const line of logs) {
    const inv = INVOKE_RE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    const exit = EXIT_RE.exec(line);
    if (exit) {
      if (stack[stack.length - 1] === exit[1]) stack.pop();
      else out.problems.push(`Unbalanced invoke stack at: ${line.slice(0, 120)}`);
      continue;
    }
    if (line === 'Log truncated') {
      out.truncated = true;
      continue;
    }
    if (!line.startsWith(DATA_PREFIX)) continue;
    const top = stack[stack.length - 1];
    if (!top || !programIds.has(top)) continue;
    const body = line.slice(DATA_PREFIX.length);
    if (body.includes(' ')) {
      out.problems.push(`Multi-segment "Program data" from ${top} is not an Anchor event; skipped`);
      continue;
    }
    out.candidates.push({ source: 'log', programId: top, payload: Buffer.from(body, 'base64') });
  }
  return out;
}

/** The subset of a `getTransaction` (encoding "json") response this recorder reads. */
export interface RpcTransaction {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions?: { programIdIndex: number; accounts?: number[]; data: string }[] } };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
    innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts?: number[]; data: string }[] }[] | null;
  } | null;
}

export function scanInnerInstructions(tx: RpcTransaction, programIds: ReadonlySet<string>): { candidates: RawEventCandidate[]; problems: string[] } {
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const candidates: RawEventCandidate[] = [];
  const problems: string[] = [];
  const groups = [...(tx.meta?.innerInstructions ?? [])].sort((a, b) => a.index - b.index);
  for (const g of groups) {
    for (const ix of g.instructions) {
      const programId = keys[ix.programIdIndex];
      if (!programId) {
        problems.push(`Inner instruction references missing account index ${ix.programIdIndex}`);
        continue;
      }
      if (!programIds.has(programId)) continue;
      let data: Uint8Array;
      try {
        data = decodeBase58(ix.data);
      } catch {
        problems.push(`Undecodable inner instruction data for ${programId}`);
        continue;
      }
      if (data.length >= 16 && EVENT_IX_TAG.every((b, i) => data[i] === b)) {
        candidates.push({ source: 'cpi', programId, payload: data.subarray(8) });
      }
    }
  }
  return { candidates, problems };
}

export interface MergedCandidate {
  programId: string;
  payload: Uint8Array;
  payloadHash: string;
  /** n-th occurrence (0-based) of this exact payload within the transaction. */
  occurrence: number;
  sources: Set<'log' | 'cpi'>;
}

export const payloadHash = (payload: Uint8Array) => createHash('sha256').update(payload).digest('hex');

/**
 * Merges candidate lists in execution order. Inner-instruction events come first when present
 * (they are never truncated); log copies of the same payload are matched by (hash, occurrence).
 */
export function mergeCandidates(primary: RawEventCandidate[], secondary: RawEventCandidate[] = []): MergedCandidate[] {
  const merged: MergedCandidate[] = [];
  const index = new Map<string, MergedCandidate>();
  for (const list of [primary, secondary]) {
    const seen = new Map<string, number>();
    for (const c of list) {
      // Keyed by payload hash alone, matching chain_events UNIQUE (signature, payload_hash, occurrence).
      const hash = payloadHash(c.payload);
      const occurrence = seen.get(hash) ?? 0;
      seen.set(hash, occurrence + 1);
      const key = `${hash}#${occurrence}`;
      const existing = index.get(key);
      if (existing) {
        existing.sources.add(c.source);
        continue;
      }
      const m: MergedCandidate = { programId: c.programId, payload: c.payload, payloadHash: hash, occurrence, sources: new Set([c.source]) };
      index.set(key, m);
      merged.push(m);
    }
  }
  return merged;
}
