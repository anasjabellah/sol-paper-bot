/**
 * Pinned pump.fun IDLs and the event decoder built from them.
 *
 * Decoder assumptions (documented in docs/DESIGN_ONCHAIN_RECORDER.md):
 *   1. An event payload is the 8-byte discriminator (sha256("event:<Name>")[0..8]) followed by the
 *      Borsh-encoded event struct, exactly as declared in the pinned IDL.
 *   2. Programs evolve events by APPENDING fields. Only an exact layout match is accepted:
 *        - payload consumed exactly            → status 'ok' (the only status stored in chain_events)
 *        - extra trailing bytes                → status 'ok_trailing': unknown bytes, so the recorder
 *                                                QUARANTINES the event (onchain_quarantine), never accepts it
 *        - payload ends exactly at a field boundary after the core fields
 *                                              → status 'partial' (older, shorter layout): quarantined
 *        - payload ends inside a field, or before the core fields, or a value is invalid
 *                                              → status 'error' (visible failure; never silently guessed)
 *   3. Unknown discriminators from a known program are reported as 'unknown_discriminator'.
 *   Evidence: with the previous pins (pump-public-docs 639b87f / 8cda1fa) every live TradeEvent,
 *   BuyEvent and SellEvent had 8 trailing bytes; pump-sdk 4.3.1 declares them as the appended
 *   field quote_transfer_fee: u64. With these pins the sampled live events decode exactly.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BorshDecodeError, BorshDecoder, BorshReader, type DecodedValue, type IdlTypeDef } from './borsh';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export type ProgramName = 'pump' | 'pump_amm';

/** Pinned IDLs: copies of src/idl/*.json from the official @pump-fun/pump-sdk 4.3.1 npm package (see idl/PROVENANCE.md). */
export const PINNED_IDLS: Record<ProgramName, { file: string; programId: string; source: string; sha256: string }> = {
  pump: {
    file: 'pump.json',
    programId: PUMP_PROGRAM_ID,
    source: '@pump-fun/pump-sdk@4.3.1/src/idl/pump.json',
    sha256: 'c53b8f5d39887afd27cc40a256527a421c2d91b64a9014dc4952a261f4f36a01',
  },
  pump_amm: {
    file: 'pump_amm.json',
    programId: PUMP_AMM_PROGRAM_ID,
    source: '@pump-fun/pump-sdk@4.3.1/src/idl/pump_amm.json (identical in @pump-fun/pump-swap-sdk@2.2.0)',
    sha256: 'c2f8ce0bc0a740d9125644b2d95494c97199fce1604802f5ab0497184bdcce61',
  },
};

/** Stored on every decoded row. Bump when decoding rules or pinned IDLs change. */
export const DECODER_VERSION = 'onchain-decoder/2 pump-sdk@4.3.1';

/**
 * Events this phase normalizes, with the number of leading fields required (the "core").
 * A shorter payload that still contains the core decodes as 'partial'.
 */
export const TARGET_EVENTS: Record<string, { program: ProgramName; coreFields: number }> = {
  CreateEvent: { program: 'pump', coreFields: 6 }, // name .. user
  TradeEvent: { program: 'pump', coreFields: 8 }, // mint .. virtual_token_reserves
  CompleteEvent: { program: 'pump', coreFields: 4 }, // user .. timestamp
  CompletePumpAmmMigrationEvent: { program: 'pump', coreFields: 8 }, // user .. pool
  BuyEvent: { program: 'pump_amm', coreFields: 16 }, // timestamp .. user
  SellEvent: { program: 'pump_amm', coreFields: 16 }, // timestamp .. user
  CreatePoolEvent: { program: 'pump_amm', coreFields: 16 }, // timestamp .. pool
};

/**
 * Anchor `emit_cpi!` prefix: the u64 constant 0x1d9acb512ea545e4 written little-endian.
 * Verified on 2026-10-29 against mainnet transactions of both programs (read-only RPC probe):
 * self-CPI inner instructions start with these bytes, followed by the event discriminator.
 */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export class IdlIntegrityError extends Error {}

interface RawIdl {
  address: string;
  metadata?: { spec?: string };
  events: { name: string; discriminator: number[] }[];
  types: IdlTypeDef[];
  accounts?: { name: string; discriminator: number[] }[];
  instructions?: { name: string; discriminator: number[]; accounts: { name: string }[] }[];
}

/** PumpSwap layouts used to resolve a pool's mints from on-chain data (never from third parties). */
export interface AmmLayout {
  decoder: BorshDecoder;
  /** sha256("account:Pool")[0..8], checked against the IDL. */
  poolAccountDiscriminatorHex: string;
  /** Swap instructions by discriminator, with the account positions of pool / base_mint / quote_mint. */
  swapInstructions: Map<string, { name: string; pool: number; baseMint: number; quoteMint: number }>;
}

export interface EventSpec {
  program: ProgramName;
  programId: string;
  name: string;
  discriminatorHex: string;
  targeted: boolean;
  coreFields: number;
}

export type DecodeStatus = 'ok' | 'ok_trailing' | 'partial' | 'unknown_discriminator' | 'error';

export interface DecodedEvent {
  status: DecodeStatus;
  programId: string;
  discriminatorHex: string;
  eventName: string | null;
  targeted: boolean;
  fields: Record<string, DecodedValue>;
  decodedFields: number;
  expectedFields: number;
  missingFields: string[];
  trailingBytes: number;
  error: string | null;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const eventDiscriminator = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);

export class EventDecoder {
  private readonly byProgram = new Map<string, { decoder: BorshDecoder; events: Map<string, EventSpec> }>();
  readonly amm: AmmLayout;

  constructor(idls: Record<ProgramName, RawIdl>) {
    for (const program of Object.keys(PINNED_IDLS) as ProgramName[]) {
      const pin = PINNED_IDLS[program];
      const idl = idls[program];
      if (idl.address !== pin.programId) throw new IdlIntegrityError(`${pin.file}: address ${idl.address} is not ${pin.programId}`);
      if (idl.metadata?.spec !== '0.1.0') throw new IdlIntegrityError(`${pin.file}: unsupported IDL spec ${idl.metadata?.spec}`);
      const decoder = new BorshDecoder(idl.types);
      const events = new Map<string, EventSpec>();
      for (const ev of idl.events) {
        const expected = hex(eventDiscriminator(ev.name));
        const declared = hex(Uint8Array.from(ev.discriminator));
        if (declared !== expected) throw new IdlIntegrityError(`${pin.file}: ${ev.name} discriminator ${declared} != sha256 prefix ${expected}`);
        if (!decoder.hasType(ev.name)) throw new IdlIntegrityError(`${pin.file}: no type layout for event ${ev.name}`);
        const target = TARGET_EVENTS[ev.name];
        events.set(declared, {
          program,
          programId: pin.programId,
          name: ev.name,
          discriminatorHex: declared,
          targeted: target?.program === program,
          coreFields: target?.program === program ? target.coreFields : decoder.structFields(ev.name).length,
        });
      }
      for (const [name, t] of Object.entries(TARGET_EVENTS)) {
        if (t.program === program && ![...events.values()].some((e) => e.name === name)) {
          throw new IdlIntegrityError(`${pin.file}: target event ${name} missing`);
        }
      }
      this.byProgram.set(pin.programId, { decoder, events });
    }
    this.amm = buildAmmLayout(idls.pump_amm, this.byProgram.get(PUMP_AMM_PROGRAM_ID)!.decoder);
  }

  isKnownProgram(programId: string): boolean {
    return this.byProgram.has(programId);
  }

  eventSpecs(): EventSpec[] {
    return [...this.byProgram.values()].flatMap((p) => [...p.events.values()]);
  }

  /** Decodes `discriminator + borsh` emitted by `programId`. Never throws for bad payloads. */
  decode(programId: string, payload: Uint8Array): DecodedEvent {
    const base: DecodedEvent = {
      status: 'error',
      programId,
      discriminatorHex: hex(payload.subarray(0, 8)),
      eventName: null,
      targeted: false,
      fields: {},
      decodedFields: 0,
      expectedFields: 0,
      missingFields: [],
      trailingBytes: 0,
      error: null,
    };
    const prog = this.byProgram.get(programId);
    if (!prog) return { ...base, error: `Program ${programId} is not decoded by this recorder` };
    if (payload.length < 8) return { ...base, error: `Payload of ${payload.length} bytes is shorter than a discriminator` };
    const spec = prog.events.get(base.discriminatorHex);
    if (!spec) return { ...base, status: 'unknown_discriminator', error: `Unknown event discriminator ${base.discriminatorHex}` };

    const fields = prog.decoder.structFields(spec.name);
    const out: DecodedEvent = { ...base, eventName: spec.name, targeted: spec.targeted, expectedFields: fields.length };
    const r = new BorshReader(payload.subarray(8));
    for (const f of fields) {
      if (r.remaining === 0) break;
      try {
        out.fields[f.name] = prog.decoder.decode(f.type, r, f.name);
        out.decodedFields++;
      } catch (err) {
        const e = err as BorshDecodeError;
        return { ...out, status: 'error', error: e instanceof BorshDecodeError ? e.message : String(err) };
      }
    }
    if (out.decodedFields < fields.length) {
      out.missingFields = fields.slice(out.decodedFields).map((f) => f.name);
      if (out.decodedFields < spec.coreFields) {
        return { ...out, status: 'error', error: `Payload ends after ${out.decodedFields} of ${spec.coreFields} core fields (unsupported layout)` };
      }
      return { ...out, status: 'partial' };
    }
    out.trailingBytes = r.remaining;
    out.status = r.remaining > 0 ? 'ok_trailing' : 'ok';
    return out;
  }
}

function buildAmmLayout(idl: RawIdl, decoder: BorshDecoder): AmmLayout {
  const pool = idl.accounts?.find((a) => a.name === 'Pool');
  const expected = hex(createHash('sha256').update('account:Pool').digest().subarray(0, 8));
  if (!pool || hex(Uint8Array.from(pool.discriminator)) !== expected) throw new IdlIntegrityError('pump_amm.json: Pool account discriminator missing or wrong');
  const prefix = decoder.structFields('Pool').slice(0, 5).map((f) => f.name).join(',');
  if (prefix !== 'pool_bump,index,creator,base_mint,quote_mint') throw new IdlIntegrityError(`pump_amm.json: unexpected Pool layout prefix ${prefix}`);
  const swapInstructions: AmmLayout['swapInstructions'] = new Map();
  for (const ix of idl.instructions ?? []) {
    if (!/^(buy|sell)/.test(ix.name)) continue;
    const names = ix.accounts.map((a) => a.name);
    const [p, b, q] = ['pool', 'base_mint', 'quote_mint'].map((n) => names.indexOf(n));
    if (p! < 0 || b! < 0 || q! < 0) continue;
    const disc = hex(Uint8Array.from(ix.discriminator));
    if (disc !== hex(createHash('sha256').update(`global:${ix.name}`).digest().subarray(0, 8))) {
      throw new IdlIntegrityError(`pump_amm.json: ${ix.name} instruction discriminator mismatch`);
    }
    swapInstructions.set(disc, { name: ix.name, pool: p!, baseMint: b!, quoteMint: q! });
  }
  if (swapInstructions.size === 0) throw new IdlIntegrityError('pump_amm.json: no swap instructions found');
  return { decoder, poolAccountDiscriminatorHex: expected, swapInstructions };
}

/** Loads the vendored IDLs, verifying their pinned SHA-256 first. */
export function loadPinnedDecoder(): EventDecoder {
  const idls = {} as Record<ProgramName, RawIdl>;
  for (const program of Object.keys(PINNED_IDLS) as ProgramName[]) {
    const pin = PINNED_IDLS[program];
    const bytes = readFileSync(new URL(`./idl/${pin.file}`, import.meta.url));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== pin.sha256) throw new IdlIntegrityError(`${pin.file}: SHA-256 ${digest} does not match the pinned ${pin.sha256}`);
    idls[program] = JSON.parse(bytes.toString('utf8')) as RawIdl;
  }
  return new EventDecoder(idls);
}
