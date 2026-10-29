# Architecture

A small TypeScript **modular monolith** in an npm-workspaces monorepo.

```
                ┌──────────────────────────── apps/api (Fastify) ─────────────────────────────┐
 DexScreener ──▶│ market/DexScreenerProvider ─┐                                                │
  (read-only)   │                             ├─▶ MarketDataService ── validate (Zod) ──┐      │
 Mock simulator▶│ market/MockMarketProvider ──┘    backoff · health · staleness         │      │
                │                                                                      ▼      │
                │  BotService (scheduler tick)                                latest observations
                │   1. market.refresh()                                                 │      │
                │   2. portfolio.markToMarket()  → peak equity, daily P&L, equity snapshot│      │
                │   3. auto kill switch on drawdown                                     │      │
                │   4. if running: strategy.evaluateExit / evaluateEntry ──▶ OrderService ◀── routes/POST /orders
                │                                                            │                │
                │      OrderService (single serialized path, mutex)          │                │
                │        idempotency → model fill (paper/accounting)         │                │
                │        → risk/evaluateRisk → atomic DB transaction → audit │                │
                │                                                            ▼                │
                │                          Repository ── Db (SQLite | PostgreSQL)             │
                └─────────────────────────────────────────────────────────────────────────────┘
                                              ▲ JSON over HTTP (CORS-restricted, localhost)
                                 apps/web (Next.js App Router dashboard, polling)
```

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/shared` | Zod schemas (observations, configs, order requests), DTO types, default configs, safety constants (`TRADING_MODE = 'PAPER'`, `REAL_TRADING_ENABLED = false`) |
| `apps/api` | All business logic, persistence and the HTTP API |
| `apps/web` | Presentation only; all state comes from the API |

## Market data

- `MarketDataProvider` is a read-only interface: `poll()`, `trackedCount()`, `rateLimitedUntil()`, `describe()`.
- Providers return `unknown[]`. **`MarketDataService` validates every record** with `MarketObservationSchema`. It rejects:
  - NaN, negative or zero prices
  - real data with non-base58 mints
  - mock data not flagged `simulated`
  - future-dated observations (more than 5 s ahead)
  - out-of-order observations.

  Rejections are counted and audited.
- `null` always means *unavailable*. The strategy treats a missing field as a failed check, never as zero.
- Health is `starting`, `ok`, `degraded` (fewer than 3 consecutive failures) or `down`. Failures back off exponentially (poll interval × 2ⁿ, capped at 120 s, and respecting `Retry-After`). The last good observations are kept and become *stale*. They are never zeroed.
- Observations are recorded to the database every 30 s for "recorded" backtests.

### Runtime provider selection

`MarketControlService` swaps the provider through `MarketDataService.setProvider`. The swap:

- discards all observations from the previous provider
- resets health
- drops any poll result still in flight from the old provider.

The swap is refused while the bot is running, or while positions from the other data source are open. The choice is persisted in `kv.market_provider` and takes precedence over `MARKET_PROVIDER` at boot. Every order records `marketDataSource`. See [DATA_SOURCES.md](DATA_SOURCES.md).

### Mock simulator

Each simulated token is an x·y=k pool driven by Poisson-distributed buy/sell flow. The bias depends on a randomly chosen regime: accumulate, pump, drift, dump, or dead (a rug that pulls about 92% of SOL liquidity). It is seeded (mulberry32), so a given seed and clock always produce the same market. Mints use the `mock_` prefix, and every record is `simulated: true`.

### DexScreener

The adapter uses these endpoints, verified against the official reference in Oct 2026:

- `/token-profiles/latest/v1` and `/token-boosts/latest/v1` for discovery (Solana only, LRU capped by `DEXSCREENER_MAX_TRACKED`)
- `/tokens/v1/solana/{≤30 addresses}` for pair data.

The deepest SOL-quoted pair on an allowed `dexId` is selected for each token. Volumes in USD are converted to SOL using `priceUsd / priceNative`.

## Strategy (deterministic)

`strategy/momentumStrategy.ts` contains pure functions that return `{ action, reasons, checks }`. No LLM or other non-deterministic component is involved.

- **Entry**: all checks must pass.
  - fresh data and an available price
  - liquidity ≥ min
  - 5m transactions ≥ min and 5m volume ≥ min
  - 5m price change within [min, max]
  - buy/sell ratio ≥ min
  - token age within bounds (fails if the age is unknown and `requireTokenAge` is set)
  - estimated entry cost ≤ `maxPriceImpactPct`: the simulated BUY's average fill price versus the exit reference price, so the quote/pool gap counts in both directions (see [Price convention](#price-convention))
  - the token is not already held and not in cooldown.
- **Exit**: the first matching condition triggers a sell.
  - take profit or stop loss, on the **net P&L of the estimated executable exit**: simulated SELL proceeds for the whole position versus fee-inclusive cost basis
  - trailing stop on the exit reference price (active only once the peak exceeded the fee-inclusive break-even price)
  - max hold time
  - liquidity drop versus entry.
- No action is taken on stale or missing data, or when a SELL cannot be modelled (missing reserves, or a quote/pool gap beyond the 15% tolerance).

## Execution model

The execution model lives in `paper/accounting.ts`. Its functions are pure and unit-tested.

| Step | Buy (spend `x` SOL) | Sell (`q` tokens) |
| --- | --- | --- |
| AMM output | `B·x / (Q + x)` tokens | `Q·q / (B + q)` SOL |
| Slippage buffer | tokens × (1 − buffer) | SOL × (1 − buffer) |
| Trading fee | `x × feeBps` added on top | deducted from proceeds |
| Network fee | flat `networkFeeSol` | flat `networkFeeSol` |
| Cash | − (x + fee + network) | + (proceeds − fee − network) |

- `Q` and `B` are the SOL and token reserves in the latest validated observation.
- If the data source's quoted price differs from the reserve-implied price `Q/B` (within the 15% tolerance), the fill is anchored to whichever is **worse for the trader**. Buys are priced at the higher of the two, sells at the lower. This matters for DexScreener PumpSwap pairs, whose quoted price is often above the reserve-implied price.
- Orders are **rejected, never filled at an unjustifiable price**, when:
  - reserves are missing
  - quoted price and reserve-implied price differ by more than 15%
  - net proceeds would be ≤ 0.
- Fills are all-or-nothing. LIMIT orders are immediate-or-cancel against the modelled price.
- Cost basis includes all entry costs. A sell releases cost basis proportionally, so realized P&L is net of entry **and** exit costs.
- Unrealized P&L is conservative: it is measured against the modelled **liquidation value** (selling everything now, after impact and fees), not the spot mark.
- Equity = virtual cash + Σ liquidation values. Peak equity drives drawdown. The UTC day start drives daily P&L.

### Price convention

Decisions, simulated fills and position state all use the same prices.

| Name | Definition | Used for |
| --- | --- | --- |
| Buy anchor | max(quoted, reserve-implied) | Pricing a simulated BUY |
| Exit reference | min(quoted, reserve-implied) | Pricing a simulated SELL, before impact, buffer and fees. Position `lastPriceSol` and `peakPriceSol`, the trailing stop, and the dashboard "Mark" |
| Entry cost | average simulated BUY price (anchor + AMM impact + buffer, fees excluded) ÷ exit reference − 1 | `max_price_impact` entry check |
| Exit P&L | (simulated SELL net proceeds − fee-inclusive cost basis) ÷ cost basis | take profit and stop loss; identical to unrealized P&L in the valuation |

- **Each cost is counted exactly once.** Entry fees are in the cost basis. AMM impact, slippage buffer, trading fee and network fee on the exit are inside the simulated SELL.
- **Stops are not exact fills.** They are evaluated on discrete observations, so if the market gaps between two observations, the SELL fills at the next observation's executable price, which can be well beyond the threshold.

**Threshold semantics.** The numbers are unchanged, but take profit and stop loss are now measured **net of estimated exit costs**, where they used to be measured on the quoted price. A take profit therefore needs a slightly larger move than before, and a stop loss fires slightly earlier. Both now match what a simulated SELL on that observation would realize.

## Risk gate

`risk/riskManager.ts` (`evaluateRisk`) runs inside the order mutex for **every** order, whether from the bot or a manual request:

- **All orders:**
  - kill switch
  - price freshness
  - duplicate window (same token and side within N ms).
- **Buys:**
  - valid size
  - max order size
  - sufficient virtual cash (including fees)
  - max exposure per token
  - max concurrent positions
  - daily loss limit and max drawdown
  - post-exit cooldown.
- **Sells:**
  - the position exists
  - the quantity is no more than the amount held.

Sells are allowed while loss limits are breached, because they reduce risk. Only the kill switch blocks them.

Duplicate prevention has three layers:

1. A unique `clientOrderId`, enforced by the database, with idempotent replay or a 409 on parameter mismatch.
2. Bot order IDs are derived from `mint + side + observation timestamp`.
3. The duplicate time window.

## Persistence

`database/db.ts` exposes one async interface for SQLite (better-sqlite3, WAL) and PostgreSQL (pg). The schema is portable: rich records are stored as JSON payloads, and filter/sort columns are promoted.

| Table | Contents |
| --- | --- |
| `kv` | account, strategy/risk configs, kill switch, cooldowns |
| `orders` | filled and rejected orders, with a unique `client_order_id` |
| `positions` | open positions |
| `decisions` | strategy decisions with snapshots and checks |
| `audit_log` | the audit trail |
| `equity_snapshots` | equity history |
| `observations` | recorded market data |

Account and position mutations happen in one transaction, behind a process-wide trading mutex. Retention pruning runs every 200 ticks.

## Backtesting

`backtest/engine.ts` reuses the live strategy, risk and accounting functions:

- Decisions at frame *t* see only frames ≤ *t*. Orders fill at frame *t+1* (next-bar).
- Orders are cancelled if the token is missing from the next frame.
- Remaining positions are liquidated at the final frame, or written off at zero if they cannot be sold.
- Reported metrics: net return after costs, max drawdown, win rate, profit factor, trade count, average trade return and fees.
- Synthetic data comes from the mock simulator on a fixed epoch with a virtual clock, so it is reproducible.

## API hardening

- The server binds to 127.0.0.1 by default. A non-loopback `HOST` requires `API_AUTH_TOKEN` (≥ 24 characters, compared in constant time).
- Other protections:
  - CORS allow-list
  - 600 requests/min rate limit
  - 64 KB body limit
  - security headers and `cache-control: no-store`
  - Zod validation of every body and query with field-level 400s
  - generic 500s (details go to the log and audit only).
