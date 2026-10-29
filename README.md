# Solana Paper Bot — pump.fun paper-trading simulator

> **PAPER TRADING ONLY.** Every order, fill, balance and P&L figure in this project is **simulated**.
> There is no wallet, no private-key handling, no transaction signing and no code path that can send a
> Solana transaction. Real trading cannot be enabled by any setting. See [docs/SAFETY.md](docs/SAFETY.md).

A complete, locally runnable paper-trading system for the Solana / pump.fun ecosystem:

- **Market data** behind a provider interface. The **mock** provider (default) is a deterministic simulated market that needs no credentials. The **DexScreener** provider uses read-only, public market data.
- **Deterministic momentum strategy.** Every decision records a timestamp, the token, a market snapshot, BUY/SELL/SKIP, its reasons, and every rule and risk check.
- **Paper-trading engine** with:
  - a constant-product AMM fill model, slippage buffer, trading fee and network fee
  - fee-inclusive cost basis, realized and unrealized P&L
  - idempotent order IDs and persistence across restarts.
- **Risk management:**
  - max order size, per-token exposure and concurrent positions
  - daily loss limit and max drawdown (with an automatic emergency stop)
  - cooldowns, duplicate-order prevention and stale-data protection
  - a **kill switch**.
- **Fastify API** with Zod validation, CORS restrictions, rate limiting and a structured audit log.
- **Next.js dashboard**: a responsive dark trading terminal for desktop and mobile.
- **Backtester** that replays the same strategy, risk and accounting code with next-bar fills (no look-ahead).
- **SQLite** by default, with optional **PostgreSQL**. Docker Compose is optional.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **20.19+ or 22 LTS** (tested on 22.18.0) | <https://nodejs.org> |
| npm | 10+ (tested on 10.9.3) | ships with Node |
| Git | any recent | optional |
| Docker Desktop | optional | only for PostgreSQL / container deployment |

On Windows, `better-sqlite3` installs a prebuilt binary, so no compiler toolchain is needed for Node 20/22 on x64.

## Quick start (Windows PowerShell)

```powershell
cd C:\path\to\solana-paper-bot
npm install
npm run dev
```

Then open **http://127.0.0.1:3000**. The API listens on **http://127.0.0.1:4000**.

- The bot **boots stopped**. Press **▶ Start** in the dashboard to let the strategy trade the simulated market.
- Defaults: mock market data, SQLite at `apps/api/data/paper.db`, 10 virtual SOL.
- To customise settings, copy the example environment file (optional):

  ```powershell
  Copy-Item .env.example apps/api/.env
  ```

See [docs/SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md) for a step-by-step guide.

## Commands (run from the repository root)

| Purpose | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Start API + dashboard (dev, hot reload) | `npm run dev` |
| Start only the API / only the dashboard | `npm run dev:api` / `npm run dev:web` |
| Run all tests | `npm test` |
| PostgreSQL integration test | see [PostgreSQL](#postgresql-optional) |
| Type-check all packages | `npm run typecheck` |
| Lint | `npm run lint` |
| Production build (API + web) | `npm run build` |
| Run production build | `npm start` |
| Offline backtest (synthetic data) | `npm run backtest` or `npm run backtest -- --seed 3 --steps 5000` |
| Backtest recorded observations | `npm run backtest -- --recorded` |
| Static "no real trading" scan | `npm run verify:no-real-trading` |
| Record real DexScreener data (separate process, own DB) | `npm run record` (optionally `-- --keep-awake`); stop with Ctrl+C |
| Recording-quality report (read-only) | `npm run record:report` (or `-- --json`) |
| Start PostgreSQL in Docker | `npm run docker:db` |
| Full Docker stack | `npm run docker:up` / `npm run docker:down` |

## Real (read-only) market data — DexScreener mode

**Select it in the dashboard:**

1. Stop the bot.
2. In the **Market data source** card, click **DEXSCREENER**.
3. The top banner changes to `DATA: REAL · DEXSCREENER (READ-ONLY) · updated Ns ago` once the first fetch succeeds.

The choice persists across restarts. Click **MOCK** to go back. Orders stay **simulated (PAPER)** in both modes.

PowerShell alternative:

```powershell
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:4000/api/market/provider -ContentType application/json -Body '{"provider":"dexscreener"}'
```

`MARKET_PROVIDER=dexscreener` in `apps/api/.env` sets the initial default only. A selection made in the dashboard takes precedence.

**Switching is refused while:**
- the bot is running, or
- positions opened on the other data source are still open. A mock position can't be priced with real data. Sell those positions or reset the paper account first.

**What you get:**
- Real token symbols and mint addresses, with price, liquidity (SOL and USD), 5m volume, buys and sells, 5m change, pair age and data freshness. Missing values are shown as `n/a`, never as 0.
- Every token is labelled **tradable** or **observation-only**, with the reason. The table also shows the first entry rule that fails.

**Data sources** (documented DexScreener GET endpoints only):
- Discovery: `token-profiles/latest`, `token-boosts/latest` and `top`, `community-takeovers/latest`, and the `search?q=pumpfun` heuristic.
- Pair data: `tokens/v1/solana/{≤30}`.

**Reliability:**
- Timeouts, bounded retries and correct HTTP 429 `Retry-After` handling.
- Local rate budgets, response caching, and a 10 s minimum poll interval.
- Per-source discovery status is shown in the dashboard.

**Coverage reality:**
- DexScreener has no documented new-launch feed.
- pump.fun bonding-curve tokens come with no reserve data, so they are observation-only.
- Most paper-tradable real tokens are graduated **PumpSwap** pools.

Details and live verification results are in **[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)**.

## PostgreSQL (optional)

```powershell
npm run docker:db                     # postgres:16 on 127.0.0.1:55432 (avoids clashing with a local PostgreSQL on 5432)
# apps/api/.env
DATABASE_URL=postgres://paperbot:paperbot@127.0.0.1:55432/paperbot
```

PostgreSQL integration test (uses the disposable `paperbot_test` database created by the container):

```powershell
$env:TEST_DATABASE_URL="postgres://paperbot:paperbot@127.0.0.1:55432/paperbot_test"; npm run test:pg; Remove-Item Env:TEST_DATABASE_URL
```

## Project layout

```
apps/
  api/            Fastify API (TypeScript, ESM)
    src/
      config/     env parsing + safety guards (Zod)
      database/   SQLite/PostgreSQL adapter, migrations, repository
      logging/    audit logger (DB + pino)
      market/     provider interface, mock simulator, DexScreener adapter, market service
      strategy/   deterministic momentum strategy
      risk/       pre-trade risk gate
      paper/      AMM fill model + accounting (pure functions)
      services/   settings, portfolio, order execution, bot scheduler
      backtest/   event-driven backtester + CLI
      routes/     HTTP endpoints
    test/         Vitest unit + integration tests
  web/            Next.js 15 App Router dashboard (Tailwind CSS 4)
packages/
  shared/         Zod schemas, DTO types, defaults, safety constants
docs/             architecture, safety, Windows setup, troubleshooting
scripts/          safety scan, PostgreSQL init
```

## API overview

All endpoints are under `/api`. Mutating requests require `Authorization: Bearer <API_AUTH_TOKEN>` when a token is configured.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness, DB status, `mode: "PAPER"`, `realTradingEnabled: false` |
| GET | `/status` | Bot state, kill switch, provider health, risk config, cost model |
| GET | `/market/status` | Provider health (state, last success, failures, rate-limit) |
| PUT | `/market/provider` | `{ "provider": "mock" }` or `{ "provider": "dexscreener" }`: select the read-only data source (bot must be stopped) |
| GET | `/market/tokens` | Latest validated observations with `stale`, `held`, `tradable` + `blockers`, and the current entry evaluation |
| GET | `/market/recordings` | Recorded snapshot counts per source |
| GET/PUT | `/strategy/config` | Strategy parameters (partial update, validated) |
| GET/PUT | `/risk/config` | Risk limits (partial update, validated) |
| POST | `/bot/start`, `/bot/stop` | Start/stop the strategy loop |
| POST | `/bot/emergency-stop` | Kill switch: `{ "reason": "..." }` |
| POST | `/bot/reset-kill-switch` | `{ "confirm": "RESET" }` (bot stays stopped) |
| GET | `/portfolio` | Virtual balance, equity, realized/unrealized P&L, drawdown |
| GET | `/portfolio/positions` | Open positions with valuation |
| GET | `/portfolio/equity?limit=` | Equity snapshots for the chart |
| POST | `/portfolio/reset` | `{ "confirm": "RESET", "startingBalanceSol": 10 }` (bot must be stopped) |
| GET | `/trades` | Filled simulated orders (paginated) |
| GET | `/orders?status=` | All orders, including rejected ones with reasons |
| POST | `/orders` | Paper order (see below) |
| GET | `/logs/decisions?action=` | Strategy decisions with checks and snapshots |
| GET | `/logs/audit?level=` | Audit trail |
| POST | `/backtest` | `{ "dataset": "synthetic", "seed": 7, "steps": 2000 }` or `{ "dataset": "recorded", "source": "dexscreener" }` |

Paper order example (PowerShell):

```powershell
$body = @{ mode="PAPER"; clientOrderId="manual-0001"; mint="mock_0001abc"; side="BUY"; sizeSol=0.25 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/orders -ContentType application/json -Body $body
```

The endpoint returns one of:

- `201` filled
- `422` rejected, with `order.rejectReason` and every risk check
- `200` idempotent replay of an existing `clientOrderId`
- `409` the same `clientOrderId` was reused with different parameters
- `400` validation error.

## Test results (as last run, 2026-10-28)

- `npm test`: **10 shared + 139 API tests passed**. 1 PostgreSQL test is skipped unless `TEST_DATABASE_URL` is set.
- PostgreSQL test against `postgres:16-alpine` in Docker: passed.
- `npm run typecheck`, `npm run lint`, `npm run build` and `npm run verify:no-real-trading`: clean.
- Live check: the DexScreener provider and the dashboard were verified against real read-only API responses. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md#live-verification-2026-10-28).

## Strategy performance — honest statement

The baseline strategy is a **transparent example, not a profitable system**.

On 20 fresh synthetic seeds (`npm run backtest -- --seeds 100-119 --steps 5000`):
- Mean net return after costs was **−5.6%**, and 4 of 20 seeds were profitable.
- With fees and slippage set to zero, the mean return was **−0.5%**.

The signal shows no edge in the simulator, and trading costs (about 3.5% per round trip) cause the loss. The defaults were deliberately left unchanged rather than fitted to the simulator. See **[docs/STRATEGY.md](docs/STRATEGY.md)**.

No real-data backtest results are reported yet. Real snapshots are recorded while the API runs in DexScreener mode (`npm run backtest -- --recorded --source dexscreener`). Synthetic results say nothing about real markets in either direction.

## Limitations

- **Execution realism.** The fill model is a constant-product AMM approximation on the latest observed reserves, anchored to the worse of the quoted and reserve-implied prices. It ignores:
  - MEV, sandwiching, failed transactions and priority-fee auctions
  - intra-poll price movement
  - pump.fun bonding-curve specifics (virtual reserves, graduation).

  Fills are all-or-nothing. LIMIT orders are immediate-or-cancel.
- **Live data and discovery.** DexScreener has no documented new-launch feed, and it exposes no reserves for pump.fun bonding-curve pairs. Most fresh launches are therefore missed or observation-only. PumpSwap reserve figures often disagree with the quoted price: pairs that differ by more than 15% are blocked, and the rest are filled at the worse of the two prices. DexScreener provides no data timestamp, so freshness is measured from fetch time. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
- **Token age** comes from `pairCreatedAt`, which reflects the pair, not necessarily the mint.
- **Single process.** Order execution is serialized with an in-process lock. Running multiple API instances against one database is not supported.
- **Precision.** Monetary values are IEEE-754 doubles. That is adequate for simulation, but this is not an exact-decimal ledger.
- **Auth.** The optional bearer token is a single shared secret. The API is designed for loopback use. When `NEXT_PUBLIC_API_TOKEN` is used, it is embedded in the browser bundle.
- **Manual positions are bot-managed.** While the bot is running, its exit rules (take profit, stop loss, trailing stop, max hold, liquidity drop) apply to **all** open positions, including ones opened manually.
- **Mock market restarts from scratch.** The mock simulator's state is not persisted, so each API start begins a new simulation run. Mock token IDs include a run ID (`mock_<run>_0006wmv`), so a new run can never re-price positions from an earlier run.
  - Such positions are held at their **last known price** minus exit costs, flagged **"no live price"**, and excluded from live unrealized P&L. They're kept in equity, so there's no false drawdown.
  - The bot skips exit decisions for them. They can't be sold, because there's no market data to justify a fill. Reset the paper account to clear them.
  - A "close at last known price" write-off is designed in [docs/DESIGN_CLOSE_AT_LAST_KNOWN_PRICE.md](docs/DESIGN_CLOSE_AT_LAST_KNOWN_PRICE.md) but not implemented.
- **Restarts.** The bot always restarts in the stopped state. The kill switch persists across restarts.
- **Backtests** of recorded data exist only after the API has been running and recording snapshots (every 60 s by default). No real history ships with the repository.

## Documentation

- [docs/SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md): PowerShell setup guide
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data flow, execution model
- [docs/SAFETY.md](docs/SAFETY.md): paper-trading safety design
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md): providers, endpoints, discovery coverage, live verification
- [docs/STRATEGY.md](docs/STRATEGY.md): why the baseline strategy loses after costs, and how to evaluate changes
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): common problems and fixes
