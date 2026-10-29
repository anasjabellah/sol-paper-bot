/**
 * Maps decoded pump / PumpSwap events onto common columns. Amounts and reserves stay as the
 * exact decimal strings produced by the decoder (raw base units of the respective mint, no
 * decimals applied). Reserves are stored as emitted; whether a program emits pre- or post-trade
 * reserves is not asserted here.
 *
 * Quote denomination: nothing is labelled SOL unless the quote mint says so. Bonding curves can be
 * quoted in SOL, USDC or other mints (observed on mainnet 2026-10-29: a USDC-quoted TradeEvent with
 * sol_amount = 0 and the amount in quote_amount). PumpSwap trade events carry no quote mint at all;
 * the recorder fills it from a recorded CreatePoolEvent / migration event when available.
 */
import type { DecodedValue } from './borsh';

/** Mints that denote SOL: the system program ID (native SOL, as pump emits it) and wrapped SOL. */
export const SOL_QUOTE_MINTS = new Set(['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);

export type QuoteAsset = 'SOL' | 'OTHER' | null;

export const quoteAssetOf = (quoteMint: string | null): QuoteAsset => (quoteMint === null ? null : SOL_QUOTE_MINTS.has(quoteMint) ? 'SOL' : 'OTHER');

export interface NormalizedEvent {
  eventType: string;
  mint: string | null;
  mintSource: 'event' | null;
  bondingCurve: string | null;
  pool: string | null;
  user: string | null;
  direction: 'buy' | 'sell' | null;
  baseAmount: string | null;
  quoteAmount: string | null;
  quoteMint: string | null;
  quoteAsset: QuoteAsset;
  reserveBaseVirtual: string | null;
  reserveQuoteVirtual: string | null;
  reserveBaseReal: string | null;
  reserveQuoteReal: string | null;
  fees: Record<string, string | number>;
  eventTimeRaw: string | null;
  /** Event timestamp in Unix seconds, or null when absent or implausible. */
  eventTimeSec: number | null;
  warnings: string[];
}

/** Earliest plausible event time (2020-01-01); later than receipt + 1 day is also implausible. */
const MIN_EVENT_TS = 1_577_836_800;

const FEE_FIELDS = [
  'fee_basis_points', 'fee', 'creator_fee_basis_points', 'creator_fee', 'creator_fee_bps',
  'lp_fee_basis_points', 'lp_fee', 'protocol_fee_basis_points', 'protocol_fee',
  'coin_creator_fee_basis_points', 'coin_creator_fee', 'cashback_fee_basis_points', 'cashback',
  'buyback_fee_basis_points', 'buyback_fee', 'holder_rewards_bps', 'holder_rewards', 'pool_migration_fee',
  'quote_transfer_fee',
];

const str = (v: DecodedValue | undefined): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

export function normalizeEvent(eventType: string, f: Record<string, DecodedValue>, receivedAtMs: number): NormalizedEvent {
  const n: NormalizedEvent = {
    eventType,
    mint: null,
    mintSource: null,
    bondingCurve: null,
    pool: null,
    user: str(f.user),
    direction: null,
    baseAmount: null,
    quoteAmount: null,
    quoteMint: str(f.quote_mint),
    quoteAsset: null,
    reserveBaseVirtual: null,
    reserveQuoteVirtual: null,
    reserveBaseReal: null,
    reserveQuoteReal: null,
    fees: {},
    eventTimeRaw: str(f.timestamp),
    eventTimeSec: null,
    warnings: [],
  };
  for (const k of FEE_FIELDS) {
    const v = f[k];
    if (typeof v === 'string' || typeof v === 'number') n.fees[k] = v;
  }
  const setMint = (v: DecodedValue | undefined) => {
    n.mint = str(v);
    n.mintSource = n.mint ? 'event' : null;
  };
  const isSolQuoted = () => quoteAssetOf(n.quoteMint) === 'SOL';

  switch (eventType) {
    case 'CreateEvent':
      setMint(f.mint);
      n.bondingCurve = str(f.bonding_curve);
      n.reserveBaseVirtual = str(f.virtual_token_reserves);
      n.reserveBaseReal = str(f.real_token_reserves);
      if (f.virtual_quote_reserves !== undefined) n.reserveQuoteVirtual = str(f.virtual_quote_reserves);
      else if (isSolQuoted()) n.reserveQuoteVirtual = str(f.virtual_sol_reserves);
      break;
    case 'TradeEvent':
      setMint(f.mint);
      n.direction = f.is_buy === true ? 'buy' : f.is_buy === false ? 'sell' : null;
      n.baseAmount = str(f.token_amount);
      n.reserveBaseVirtual = str(f.virtual_token_reserves);
      n.reserveBaseReal = str(f.real_token_reserves);
      if (f.quote_amount !== undefined) {
        // Layouts with quote_* fields: these are denominated in quote_mint (SOL or not).
        n.quoteAmount = str(f.quote_amount);
        n.reserveQuoteVirtual = str(f.virtual_quote_reserves);
        n.reserveQuoteReal = str(f.real_quote_reserves);
      } else {
        // Older layouts only have sol_* fields; leave quote columns empty (still in fields_json).
        n.warnings.push('quote_fields_absent');
      }
      break;
    case 'CompleteEvent':
      setMint(f.mint);
      n.bondingCurve = str(f.bonding_curve);
      break;
    case 'CompletePumpAmmMigrationEvent':
      setMint(f.mint);
      n.bondingCurve = str(f.bonding_curve);
      n.pool = str(f.pool);
      n.baseAmount = str(f.mint_amount);
      // The IDL names this field sol_amount; its meaning for non-SOL quotes is unverified.
      if (isSolQuoted()) n.quoteAmount = str(f.sol_amount);
      else n.warnings.push('sol_amount_not_mapped_for_non_sol_quote');
      break;
    case 'BuyEvent':
    case 'SellEvent':
      // PumpSwap trade events carry neither the mint nor the quote mint; see the recorder's pool map.
      n.pool = str(f.pool);
      n.direction = eventType === 'BuyEvent' ? 'buy' : 'sell';
      n.baseAmount = str(eventType === 'BuyEvent' ? f.base_amount_out : f.base_amount_in);
      n.quoteAmount = str(eventType === 'BuyEvent' ? f.quote_amount_in : f.quote_amount_out);
      n.reserveBaseReal = str(f.pool_base_token_reserves);
      n.reserveQuoteReal = str(f.pool_quote_token_reserves);
      n.reserveQuoteVirtual = str(f.virtual_quote_reserves); // i128; documented as possibly negative
      break;
    case 'CreatePoolEvent':
      setMint(f.base_mint);
      n.pool = str(f.pool);
      n.user = str(f.creator);
      n.baseAmount = str(f.base_amount_in);
      n.quoteAmount = str(f.quote_amount_in);
      n.reserveBaseReal = str(f.pool_base_amount);
      n.reserveQuoteReal = str(f.pool_quote_amount);
      break;
    default:
      break;
  }
  n.quoteAsset = quoteAssetOf(n.quoteMint);

  if (n.eventTimeRaw !== null) {
    const ts = BigInt(n.eventTimeRaw);
    if (ts >= BigInt(MIN_EVENT_TS) && ts <= BigInt(Math.floor(receivedAtMs / 1000) + 86_400)) n.eventTimeSec = Number(ts);
    else n.warnings.push(`implausible_timestamp:${n.eventTimeRaw}`);
  }
  return n;
}
