/**
 * SYNTHETIC test fixtures for the on-chain recorder. Event payloads come from a test-only Borsh
 * encoder driven by the pinned IDLs; addresses and signatures are sha256-derived placeholders; logs
 * and transactions are hand-built in the documented RPC shapes; WebSocket and RPC clients are fakes.
 * None of this is captured mainnet data.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeBase58, encodeBase58 } from '../src/onchain/base58';
import type { DecodedValue, IdlType, IdlTypeDef } from '../src/onchain/borsh';
import type { RpcTransaction } from '../src/onchain/extract';
import { BudgetExhaustedError, type SignatureInfo } from '../src/onchain/helius';
import { EVENT_IX_TAG, eventDiscriminator } from '../src/onchain/idl';
import type { RpcLike, WsLike } from '../src/onchain/recorder';

export const sha = (s: string) => createHash('sha256').update(s).digest();
export const synthAddress = (label: string) => encodeBase58(sha(`synthetic-address:${label}`));
export const synthSignature = (label: string) => encodeBase58(Buffer.concat([sha(`synthetic-sig-a:${label}`), sha(`synthetic-sig-b:${label}`)]));
export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

export const IDLS = {
  pump: JSON.parse(readFileSync(new URL('../src/onchain/idl/pump.json', import.meta.url), 'utf8')) as { types: IdlTypeDef[] },
  pump_amm: JSON.parse(readFileSync(new URL('../src/onchain/idl/pump_amm.json', import.meta.url), 'utf8')) as { types: IdlTypeDef[] },
};
const INT_BYTES: Record<string, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16 };

/** Test-only Borsh encoder (the inverse of the decoder under test), driven by the IDL. */
export function encodeValue(types: Map<string, IdlTypeDef>, type: IdlType, v: DecodedValue, out: number[]): void {
  if (typeof type === 'string') {
    const bytes = INT_BYTES[type];
    if (bytes) {
      let x = BigInt(v as string | number);
      if (x < 0n) x += 1n << BigInt(bytes * 8);
      for (let i = 0; i < bytes; i++) {
        out.push(Number(x & 0xffn));
        x >>= 8n;
      }
      return;
    }
    if (type === 'bool') return void out.push(v ? 1 : 0);
    if (type === 'pubkey') return void out.push(...decodeBase58(v as string));
    if (type === 'string') {
      const s = Buffer.from(v as string, 'utf8');
      encodeValue(types, 'u32', s.length, out);
      return void out.push(...s);
    }
    throw new Error(`encoder: unsupported ${type}`);
  }
  if ('vec' in type) {
    const arr = v as DecodedValue[];
    encodeValue(types, 'u32', arr.length, out);
    for (const x of arr) encodeValue(types, type.vec, x, out);
    return;
  }
  if ('option' in type) {
    if (v === null) return void out.push(0);
    out.push(1);
    return encodeValue(types, type.option, v, out);
  }
  if ('array' in type) {
    for (const x of v as DecodedValue[]) encodeValue(types, type.array[0], x, out);
    return;
  }
  if ('defined' in type) {
    const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
    const def = types.get(name)!;
    if (def.type.kind === 'struct') {
      for (const f of (def.type as { fields: { name: string; type: IdlType }[] }).fields) encodeValue(types, f.type, (v as Record<string, DecodedValue>)[f.name]!, out);
      return;
    }
    const variants = (def.type as { variants: { name: string }[] }).variants;
    return void out.push(variants.findIndex((x) => x.name === v));
  }
  throw new Error('encoder: unsupported type');
}

export const SYNTH_TS = String(Date.UTC(2026, 5, 1, 12, 0, 0) / 1000);

/** Deterministic synthetic value for a field; u64 values exceed 2^53 to prove exactness. */
export function synthValue(types: Map<string, IdlTypeDef>, type: IdlType, name: string): DecodedValue {
  if (typeof type === 'string') {
    if (name === 'timestamp') return SYNTH_TS;
    const h = sha(name).readUInt16LE(0);
    switch (type) {
      case 'u8': return h % 200;
      case 'u16': return h;
      case 'u32': case 'i32': case 'i16': case 'i8': return h % 100;
      case 'u64': return (2n ** 53n + BigInt(h)).toString();
      case 'i64': return (-(2n ** 60n) - BigInt(h)).toString();
      case 'u128': return (2n ** 127n + BigInt(h)).toString();
      case 'i128': return (-(2n ** 126n) - BigInt(h)).toString();
      case 'bool': return h % 2 === 0;
      case 'pubkey': return synthAddress(name);
      case 'string': return `synthetic-${name}`;
    }
    throw new Error(`synth: ${type}`);
  }
  if ('vec' in type) return [synthValue(types, type.vec, `${name}[0]`)];
  if ('option' in type) return null;
  if ('array' in type) return Array.from({ length: type.array[1] }, (_, i) => synthValue(types, type.array[0], `${name}[${i}]`));
  if ('defined' in type) {
    const tn = typeof type.defined === 'string' ? type.defined : type.defined.name;
    const def = types.get(tn)!;
    if (def.type.kind === 'struct') {
      const o: Record<string, DecodedValue> = {};
      for (const f of (def.type as { fields: { name: string; type: IdlType }[] }).fields) o[f.name] = synthValue(types, f.type, `${name}.${f.name}`);
      return o;
    }
    return (def.type as { variants: { name: string }[] }).variants[0]!.name;
  }
  throw new Error('synth: unsupported');
}

/** A SYNTHETIC event payload (discriminator + borsh) for an event of the pinned IDL. */
export function synthEvent(program: 'pump' | 'pump_amm', name: string, overrides: Record<string, DecodedValue> = {}) {
  const types = new Map(IDLS[program].types.map((t) => [t.name, t]));
  const fieldDefs = (types.get(name)!.type as { fields: { name: string; type: IdlType }[] }).fields;
  const fields: Record<string, DecodedValue> = {};
  for (const f of fieldDefs) fields[f.name] = f.name in overrides ? overrides[f.name]! : synthValue(types, f.type, f.name);
  const out: number[] = [...eventDiscriminator(name)];
  for (const f of fieldDefs) encodeValue(types, f.type, fields[f.name]!, out);
  return { fields, payload: Uint8Array.from(out), fieldDefs };
}

export const ixLogs = (programId: string, payloads: Uint8Array[]) => [
  'Program ComputeBudget111111111111111111111111111111 invoke [1]',
  'Program ComputeBudget111111111111111111111111111111 success',
  `Program ${programId} invoke [1]`,
  'Program log: Instruction: Buy',
  ...payloads.map((p) => `Program data: ${b64(p)}`),
  `Program ${programId} consumed 41000 of 200000 compute units`,
  `Program ${programId} success`,
];

/** A SYNTHETIC getTransaction (encoding json) result with self-CPI events and matching logs. */
export function synthTx(slot: number, programId: string, payloads: Uint8Array[], opts: { err?: unknown; logs?: string[]; blockTime?: number } = {}): RpcTransaction {
  return {
    slot,
    blockTime: opts.blockTime ?? Number(SYNTH_TS),
    transaction: { signatures: [synthSignature(`tx-${slot}`)], message: { accountKeys: [synthAddress('payer'), programId, synthAddress('mint')] } },
    meta: {
      err: opts.err ?? null,
      logMessages: opts.logs ?? ixLogs(programId, payloads),
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: [
        { index: 0, instructions: payloads.map((p) => ({ programIdIndex: 1, data: encodeBase58(Uint8Array.from([...EVENT_IX_TAG, ...p])) })) },
      ],
    },
  };
}


export class FakeWs implements WsLike {
  sent: { id: number; method: string; params: unknown[] }[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }
  open() {
    this.onopen?.({});
  }
  msg(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
  /** Confirms every logsSubscribe; returns address -> subscription id. */
  confirmAll(base = 100): Map<string, number> {
    const m = new Map<string, number>();
    this.sent.forEach((s, i) => {
      if (s.method !== 'logsSubscribe') return;
      m.set((s.params[0] as { mentions: string[] }).mentions[0]!, base + i);
      this.msg({ jsonrpc: '2.0', id: s.id, result: base + i });
    });
    return m;
  }
  notify(sub: number, signature: string, slot: number, logs: string[], err: unknown = null) {
    this.msg({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot }, value: { signature, err, logs } } } });
  }
  serverDrop() {
    this.closed = { code: 1006 };
    this.onclose?.({ code: 1006, reason: '' });
  }
}

export class FakeRpc implements RpcLike {
  sigCalls: { address: string; until?: string; before?: string; limit: number }[] = [];
  txCalls: string[] = [];
  sigPages: SignatureInfo[][] = [];
  txs = new Map<string, RpcTransaction>();
  budgetExhausted = false;
  async getSignaturesForAddress(address: string, opts: { until?: string; before?: string; limit: number }) {
    this.sigCalls.push({ address, ...opts });
    return this.sigPages.shift() ?? [];
  }
  async getTransaction<T>(signature: string): Promise<T | null> {
    this.txCalls.push(signature);
    if (this.budgetExhausted) throw new BudgetExhaustedError('synthetic budget');
    return (this.txs.get(signature) ?? null) as T | null;
  }
  accountCalls: string[] = [];
  /** SYNTHETIC account data by address; missing = account not found. */
  accounts = new Map<string, { owner: string; data: [string, string] }>();
  accountError: Error | null = null;
  async getAccountInfo(address: string) {
    this.accountCalls.push(address);
    if (this.accountError) throw this.accountError;
    return this.accounts.get(address) ?? null;
  }
}

