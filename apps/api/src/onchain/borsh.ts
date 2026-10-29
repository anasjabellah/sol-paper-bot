/**
 * IDL-driven Borsh decoder (Anchor IDL spec 0.1.0 type grammar).
 *
 * Exactness rules:
 *   - u64 / i64 / u128 / i128 are read as BigInt and returned as exact decimal strings.
 *     They never pass through JavaScript floating-point numbers.
 *   - u8..u32 / i8..i32 are returned as numbers (always exact).
 *   - pubkey is returned as a base58 string.
 * Every failure throws BorshDecodeError with the field path and byte offset; nothing is guessed.
 */
import { encodeBase58 } from './base58';

export type IdlType =
  | string
  | { vec: IdlType }
  | { option: IdlType }
  | { coption: IdlType }
  | { array: [IdlType, number] }
  | { defined: { name: string; generics?: unknown[] } | string };

export interface IdlField {
  name: string;
  type: IdlType;
}

export interface IdlTypeDef {
  name: string;
  type:
    | { kind: 'struct'; fields?: (IdlField | IdlType)[] }
    | { kind: 'enum'; variants: { name: string; fields?: (IdlField | IdlType)[] }[] }
    | { kind: string };
}

export type DecodedValue = string | number | boolean | null | DecodedValue[] | { [k: string]: DecodedValue };

export class BorshDecodeError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly offset: number,
    /** True when the input ended before the value could be read. */
    readonly truncated: boolean,
  ) {
    super(`${message} at ${path || '<root>'} (byte ${offset})`);
  }
}

/** Upper bound for vec/string lengths, so a corrupt length cannot allocate huge arrays. */
const MAX_LENGTH = 1_000_000;

const INT_SIZES: Record<string, { bytes: number; signed: boolean }> = {
  u8: { bytes: 1, signed: false },
  i8: { bytes: 1, signed: true },
  u16: { bytes: 2, signed: false },
  i16: { bytes: 2, signed: true },
  u32: { bytes: 4, signed: false },
  i32: { bytes: 4, signed: true },
  u64: { bytes: 8, signed: false },
  i64: { bytes: 8, signed: true },
  u128: { bytes: 16, signed: false },
  i128: { bytes: 16, signed: true },
};

export class BorshReader {
  offset = 0;
  constructor(readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  take(n: number, path: string): Uint8Array {
    if (n > this.remaining) {
      throw new BorshDecodeError(`Need ${n} bytes, ${this.remaining} left`, path, this.offset, true);
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** Little-endian integer as BigInt (two's complement when signed). */
  bigint(bytes: number, signed: boolean, path: string): bigint {
    const b = this.take(bytes, path);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    if (signed && b[bytes - 1]! & 0x80) v -= 1n << BigInt(bytes * 8);
    return v;
  }

  length(path: string): number {
    const n = Number(this.bigint(4, false, path));
    if (n > MAX_LENGTH) throw new BorshDecodeError(`Length ${n} exceeds limit`, path, this.offset - 4, false);
    return n;
  }
}

export class BorshDecoder {
  private readonly types: Map<string, IdlTypeDef>;

  constructor(types: IdlTypeDef[]) {
    this.types = new Map(types.map((t) => [t.name, t]));
  }

  hasType(name: string): boolean {
    return this.types.has(name);
  }

  /** Field list of a struct type (throws for unknown or non-struct types). */
  structFields(name: string): IdlField[] {
    const def = this.types.get(name);
    if (!def || def.type.kind !== 'struct') throw new Error(`IDL type ${name} is not a struct`);
    return ((def.type as { fields?: (IdlField | IdlType)[] }).fields ?? []).map((f, i) => normalizeField(f, i));
  }

  decode(type: IdlType, r: BorshReader, path: string): DecodedValue {
    if (typeof type === 'string') return this.primitive(type, r, path);
    if ('vec' in type) {
      const n = r.length(path);
      const out: DecodedValue[] = [];
      for (let i = 0; i < n; i++) out.push(this.decode(type.vec, r, `${path}[${i}]`));
      return out;
    }
    if ('option' in type) return this.optional(type.option, 1, r, path);
    if ('coption' in type) return this.optional(type.coption, 4, r, path);
    if ('array' in type) {
      const [inner, n] = type.array;
      const out: DecodedValue[] = [];
      for (let i = 0; i < n; i++) out.push(this.decode(inner, r, `${path}[${i}]`));
      return out;
    }
    if ('defined' in type) {
      const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
      if (typeof type.defined !== 'string' && type.defined.generics?.length) {
        throw new BorshDecodeError(`Generic type ${name} is not supported`, path, r.offset, false);
      }
      return this.definedType(name, r, path);
    }
    throw new BorshDecodeError(`Unsupported IDL type ${JSON.stringify(type)}`, path, r.offset, false);
  }

  definedType(name: string, r: BorshReader, path: string): DecodedValue {
    const def = this.types.get(name);
    if (!def) throw new BorshDecodeError(`Unknown IDL type ${name}`, path, r.offset, false);
    if (def.type.kind === 'struct') {
      const out: Record<string, DecodedValue> = {};
      for (const f of this.structFields(name)) out[f.name] = this.decode(f.type, r, path ? `${path}.${f.name}` : f.name);
      return out;
    }
    if (def.type.kind === 'enum') {
      const variants = (def.type as { variants: { name: string; fields?: (IdlField | IdlType)[] }[] }).variants;
      const at = r.offset;
      const tag = Number(r.bigint(1, false, path));
      const v = variants[tag];
      if (!v) throw new BorshDecodeError(`Enum ${name} has no variant ${tag}`, path, at, false);
      if (!v.fields?.length) return v.name;
      const fields: Record<string, DecodedValue> = {};
      v.fields.forEach((f, i) => {
        const nf = normalizeField(f, i);
        fields[nf.name] = this.decode(nf.type, r, `${path}.${v.name}.${nf.name}`);
      });
      return { [v.name]: fields };
    }
    throw new BorshDecodeError(`Unsupported type kind ${def.type.kind} for ${name}`, path, r.offset, false);
  }

  private optional(inner: IdlType, tagBytes: number, r: BorshReader, path: string): DecodedValue {
    const at = r.offset;
    const tag = Number(r.bigint(tagBytes, false, path));
    if (tag === 0) {
      // A C-style option still reserves the inner value's bytes.
      if (tagBytes === 4) this.decode(inner, r, path);
      return null;
    }
    if (tag !== 1) throw new BorshDecodeError(`Invalid option tag ${tag}`, path, at, false);
    return this.decode(inner, r, path);
  }

  private primitive(type: string, r: BorshReader, path: string): DecodedValue {
    const int = INT_SIZES[type];
    if (int) {
      const v = r.bigint(int.bytes, int.signed, path);
      return int.bytes <= 4 ? Number(v) : v.toString();
    }
    switch (type) {
      case 'bool': {
        const at = r.offset;
        const b = r.take(1, path)[0];
        if (b !== 0 && b !== 1) throw new BorshDecodeError(`Invalid bool byte ${b}`, path, at, false);
        return b === 1;
      }
      case 'pubkey':
      case 'publicKey':
        return encodeBase58(r.take(32, path));
      case 'string': {
        const n = r.length(path);
        return new TextDecoder('utf-8', { fatal: false }).decode(r.take(n, path));
      }
      case 'bytes': {
        const n = r.length(path);
        return Buffer.from(r.take(n, path)).toString('base64');
      }
      case 'f32':
        return Buffer.from(r.take(4, path)).readFloatLE(0);
      case 'f64':
        return Buffer.from(r.take(8, path)).readDoubleLE(0);
      default:
        throw new BorshDecodeError(`Unsupported primitive type ${type}`, path, r.offset, false);
    }
  }
}

function normalizeField(f: IdlField | IdlType, i: number): IdlField {
  return typeof f === 'object' && f !== null && 'name' in f && 'type' in f ? (f as IdlField) : { name: String(i), type: f as IdlType };
}
