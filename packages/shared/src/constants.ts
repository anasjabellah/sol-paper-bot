/**
 * Safety constants. These are compile-time literals on purpose: there is no
 * configuration path (env var, API call, dashboard toggle) that can change them.
 */
export const TRADING_MODE = 'PAPER' as const;
export const REAL_TRADING_ENABLED = false as const;

/** Wrapped SOL mint - the quote asset all simulated prices are expressed in. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Solana base58 address: 32-44 chars from the bitcoin base58 alphabet. */
export const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Mock tokens use an explicit prefix so they can never be mistaken for real mints. */
export const MOCK_MINT_PREFIX = 'mock_';

export const SIMULATION_DISCLAIMER =
  'PAPER TRADING ONLY - all orders, fills and balances are simulated. No real transactions are ever sent.';

/** Pair creation timestamps further than this into the future are treated as invalid data. */
export const MAX_PAIR_CREATED_SKEW_MS = 5 * 60_000;

/** Which market-data source a mint belongs to (mock mints carry an explicit prefix). */
export function sourceOfMint(mint: string): 'mock' | 'dexscreener' {
  return mint.startsWith(MOCK_MINT_PREFIX) ? 'mock' : 'dexscreener';
}
