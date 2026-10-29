# Paper-trading safety

This project is a **simulator**. These guarantees are enforced by design, by code, and by tests.

## What does not exist in this codebase

- No wallet connection, wallet import, keypair or private-key handling.
- No transaction construction, signing or submission to Solana, and no swap or trade API calls.
- No Solana signing SDKs (`@solana/web3.js`, `@solana/kit`, Anchor, `bs58`, `tweetnacl`, Jupiter) in any `package.json`.
- No "live mode". `TRADING_MODE = 'PAPER'` and `REAL_TRADING_ENABLED = false` are compile-time literals in `packages/shared/src/constants.ts`. No environment variable, API field or dashboard control reads or changes them.

## Enforcement

| Guard | Where |
| --- | --- |
| API refuses to start if env vars matching `PRIVATE_KEY`, `SEED_PHRASE`, `MNEMONIC`, `WALLET_KEY/SECRET`, `KEYPAIR`, or `(ENABLE_)REAL/LIVE_TRADING` are set | `apps/api/src/config/env.ts` |
| Every order request must carry `mode: "PAPER"`; anything else is a 400. Unknown fields (e.g. `privateKey`) are rejected by strict schemas | `packages/shared/src/schemas.ts` |
| Config schemas are strict; unknown keys like `enableRealTrading` are rejected | same |
| Static scan of all source and manifests for signing / wallet / swap code | `npm run verify:no-real-trading`, `apps/api/test/safety.test.ts` |
| Market data adapters only issue HTTP `GET` to documented public endpoints (tested: every request URL and method) | `apps/api/src/market/`, `apps/api/test/dexscreener.test.ts` |
| Selecting real market data (`PUT /api/market/provider`) only changes where observations come from. The strict schema accepts nothing but `provider`, and `mode` / `realTradingEnabled` stay `PAPER` / `false` (tested) | `MarketControlService`, `apps/api/test/provider.test.ts` |
| Mock and real records can never be mixed: mismatched `source` / `simulated` flags are rejected, switching discards old observations, and positions from the other source block switching | `MarketDataService`, `MarketControlService` |
| Mock data is always flagged `simulated: true` with `mock_` mints; live data can never be flagged simulated, and real mints must be base58 | `MarketObservationSchema` |
| Dashboard shows a persistent **PAPER MODE · SIMULATION ONLY** banner and labels simulated vs live data | `apps/web/src/components/Dashboard.tsx` |
| Every order and balance is marked `simulated: true` / `virtual: true` in API responses; header `x-trading-mode: PAPER-SIMULATION-ONLY` | API |

## Risk controls (also apply to paper trading)

- **Kill switch** (`POST /api/bot/emergency-stop`, or the red dashboard button):
  - takes effect in memory before it is persisted, so it applies immediately
  - stops the bot and rejects every new simulated order
  - persists across restarts
  - requires an explicit `{"confirm":"RESET"}` to clear, after which the bot stays stopped.
- The kill switch is tripped **automatically** when drawdown reaches `maxDrawdownPct` (configurable).
- Other limits: daily loss, per-order size, per-token exposure, concurrent positions, post-exit cooldown, duplicate-order window and stale-data rejection. See [ARCHITECTURE.md](ARCHITECTURE.md#risk-gate).
- The bot **always boots stopped**.
- Persistent audit records are kept for decisions, filled orders, rejected orders (with every failed check), configuration changes, kill-switch events, provider failures and errors.

## Network exposure

- The API binds to `127.0.0.1` by default, and the dashboard dev and production servers bind to `127.0.0.1:3000`.
- Binding the API to any other interface requires `API_AUTH_TOKEN` (≥ 24 characters). Without it, the API exits on startup.
- Docker Compose publishes every port on `127.0.0.1` only.
- **Public internet deployment is not supported.** The optional token is a single shared secret. If `NEXT_PUBLIC_API_TOKEN` is used, the token is embedded in the browser bundle.

## Honest performance reporting

- Backtests and paper results are labelled by data source (synthetic, recorded, or live-observed paper trading).
- The baseline strategy **loses money after costs on the synthetic simulator** (see README). Nothing in this project should be read as evidence that a strategy is profitable.
- The fill model is an approximation. See README → Limitations.

## If you want to trade for real

That is out of scope, and this codebase is intentionally not a starting point for it.
