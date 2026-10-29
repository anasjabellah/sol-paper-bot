# Market data sources, discovery coverage and limitations

All market data is **read-only**. Selecting a provider never changes the trading mode: orders are always simulated (PAPER).

## Selecting the provider

- **Dashboard:** in the **Market data source** card, choose **MOCK** or **DEXSCREENER**. The selection is stored in the database and is used again after a restart.
- **API:** `PUT /api/market/provider` with `{"provider":"dexscreener"}` or `{"provider":"mock"}`.
- **Env default:** `MARKET_PROVIDER` is used only until a selection has been made in the dashboard. `GET /api/status` → `providerSelectedBy` reports which one is in effect: `env`, `dashboard` or `injected`.

Switching is refused (HTTP 409) in two cases:

| Code | Why |
| --- | --- |
| `BOT_RUNNING` | Stop the bot first. |
| `POSITIONS_FROM_OTHER_SOURCE` | An open position was opened on the other data source. A `mock_…` position cannot be priced or exited with DexScreener data, and vice versa. Sell it (Manual paper order → SELL 100%) or reset the paper account. |

When the provider changes, every observation from the previous provider is discarded and health is reset to `starting`. As defence in depth, records whose `source` or `simulated` flag do not match the active provider are rejected.

## Mock provider

A deterministic simulator. Every record has `source: "mock"`, `simulated: true` and a `mock_` mint prefix, and the dashboard labels it "MOCK · simulated". It is never presented as real market data.

Mint IDs are scoped to a simulation run: `mock_<runId>_<seq><sym>`, where `runId` is the run's start time in base36.
- Every API start (or switch to mock) is a new run, so it can never reuse an earlier run's token identities and re-price positions opened in that run.
- Positions from an earlier run, including legacy IDs without a run ID such as `mock_0006wmv`, get no observations. They are valued at their last known price, flagged as not live, and reported separately (`stalePositions`, `staleValueSol`, `staleUnrealizedPnlSol` in `GET /api/portfolio`).
- The same seed and start time still reproduce a run exactly, which keeps synthetic backtests deterministic.

## DexScreener provider (real data)

Only endpoints documented at <https://docs.dexscreener.com/api/reference> are used, and every request is a `GET`.

| Purpose | Endpoint | Documented limit | Budget used here |
| --- | --- | --- | --- |
| Discovery | `/token-profiles/latest/v1` | 60/min | shared 30/min list budget, once per `DEXSCREENER_DISCOVERY_INTERVAL_MS` (60 s) |
| Discovery | `/token-boosts/latest/v1` | 60/min | ″ |
| Discovery | `/token-boosts/top/v1` | 60/min | ″ |
| Discovery | `/community-takeovers/latest/v1` | 60/min | ″ |
| Discovery (heuristic) | `/latest/dex/search?q=<query>` | 300/min | shared 150/min pair budget |
| Pair data | `/tokens/v1/solana/{≤30 addresses}` | 300/min | ≤ 1 batch per token chunk per poll, at most every 10 s |

### Reliability features

| Feature | Behaviour |
| --- | --- |
| Timeout | 10 s per request. |
| Retries | Up to 2 retries (0.75 s, then 2 s) for network errors, timeouts, 5xx responses and invalid JSON. |
| Rate limits | **HTTP 429 is never retried immediately.** The provider honours `Retry-After` (default 30 s) and skips the remaining discovery sources in that round. |
| Local rate budgets | A sliding-window limiter keeps requests at about half of each documented limit. |
| Cache | Polls faster than `DEXSCREENER_MIN_POLL_INTERVAL_MS` (default 10 s) are served from cache. The market service also never polls faster than the provider minimum. |
| Partial failure | One failed pair chunk or one failed discovery source does not fail the poll. Problems are shown as warnings and in per-source discovery status in the dashboard. |
| Backoff | Whole-poll failures back off exponentially, capped at 120 s. Health moves through `starting` → `ok` / `degraded` / `down`. `ok` requires an actual successful poll. |

### Discovery vs refresh, and timestamps

**Discovery** (every 60 s) only decides *which* tokens are tracked. **Pair data for every tracked token is re-fetched on every poll** (about every 10 s) via `/tokens/v1/solana/{≤30}`.

The tracked set is capped at `DEXSCREENER_MAX_TRACKED`.
- **Never evicted:** mints of open paper positions (pinned on every bot tick) and watchlist mints.
- **Evicted first:** tokens last seen without pool reserves (observation-only), then never-fetched discoveries, then tokens with reserves, oldest first within each group.

A token evicted from tracking keeps its last observation in the table, labelled **"not refreshed"**. It is not tradable, and the pipeline counts it as observed but not tracked.

Each token exposes these timestamps:

| Field | Meaning |
| --- | --- |
| `fetchedAt` / `observedAt` | When this application received the data. Freshness (`maxDataAgeMs`) is measured from this. |
| `sourceTimestamp` | Always `null`: DexScreener reports no per-record market timestamp. Fetch time is never presented as the source's update time. |
| `lastChangedAt` | When price, liquidity, volume or transaction fields last changed between fetches. The dashboard flags "data unchanged" after 60 s. This is informational only; it does not block trading. |
| `pairCreatedAt` | Pair creation time, used only for the token-age rule and never as a market update time. |
| Provider `lastSuccessAt` | When the last poll succeeded. |

### Validation

Data is rejected rather than repaired:

- Each pair is schema-validated. Malformed pair records are dropped and counted.
- Only Solana pairs quoted in wrapped SOL on an allowed `dexId` (default `pumpfun,pumpswap`) are used. The deepest pool is selected.
- Observations are rejected for:
  - non-base58 mints
  - non-positive, NaN or infinite prices
  - future timestamps, including `pairCreatedAt` more than 5 minutes in the future
  - out-of-order observations.
- **Missing values are `null` ("n/a" in the UI), never 0.** Examples:
  - USD volume cannot be converted to SOL without both prices, so it is `null`.
  - Reserves are `null` unless *both* sides of the pool are present.
  - URLs that are not `https://` are dropped.
- Freshness is measured from fetch time, because DexScreener returns no data timestamp. Data older than `maxDataAgeMs` (30 s) is **stale**: it is shown, but it cannot be traded.

### What can be paper-traded

A token is **tradable** only when the simulator can model a fill responsibly:

1. Both pool reserves (`liquidity.quote` and `liquidity.base`) are present.
2. The quoted price and the reserve-implied price agree within 15%.
3. The data is fresh.

Everything else is **observation-only**. It appears in the table with the exact reason, and both the bot and manual orders are blocked with `execution_model: …`.

When the quoted and reserve prices differ but are within the tolerance, fills are anchored to the price that is **worse for the trader**: buys use the higher price, sells the lower. The strategy's price-impact check includes that premium.

## Live verification (2026-10-28)

Observed against the live API from this machine:

- **Discovery:** all 5 sources returned data (profiles 24–25, boosts latest 23, boosts top 24, takeovers 11, `search:pumpfun` 30 Solana tokens). 38–50 tokens were tracked after evicting tokens without a usable pair.
- **pump.fun bonding-curve pairs** (`dexId: pumpfun`, 27–43 of the tracked tokens):
  - They had **no `liquidity` object at all**, so they were all observation-only.
  - `search?q=pumpfun` surfaced bonding-curve tokens as young as **1–4 minutes**.
- **PumpSwap pairs** (`dexId: pumpswap`, about 12):
  - All had reserves.
  - The quoted `priceNative` was consistently **higher** than `liquidity.quote / liquidity.base`, by 13–55%.
  - The 5–6 pairs that disagreed by more than 15% were blocked. About 7 were tradable.
  - DexScreener does not document the cause; treat the reserve figures as approximate.

## Discovery coverage: what you will and will not see

DexScreener has **no documented "new pump.fun launches" feed**, so coverage of new launches is partial and biased.

| Source | What it really is | Coverage of new launches |
| --- | --- | --- |
| token-profiles / boosts / takeovers | Curated, mostly **paid** listings (~30 items each) | Tokens whose teams paid for a profile or boost. Median pair age in a live sample was 56–101 min. |
| `search?q=pumpfun` | Relevance-ranked text search, capped at ~30 pairs | Often includes very young bonding-curve tokens, but the ranking is undocumented. Not a complete or chronological feed. |
| `DEXSCREENER_WATCHLIST` | Mints you specify | Always tracked. |

Consequences:

- Most freshly launched pump.fun tokens are **missed**. The ones that are found are almost always **still on the bonding curve**, so they are observation-only: DexScreener gives no reserves for them.
- Paper trading on real data is therefore effectively limited to **graduated PumpSwap pools** whose reported reserves agree with the quoted price.

### Alternatives considered and not implemented

| Option | Why it was not implemented |
| --- | --- |
| **PumpPortal websocket** (`subscribeNewToken`) | A free new-token stream, but it is a third-party trading service: its docs require an API key and a funded linked wallet for some streams, and it sells transaction APIs. That conflicts with this project's no-wallet, paper-only design. |
| **Solana RPC** (read-only `getAccountInfo` on bonding-curve accounts, or `logsSubscribe` on the pump.fun program) | Would give exact bonding-curve reserves and launch events. Deriving the accounts needs Solana SDK primitives, which this repository deliberately excludes. Public RPC endpoints are also heavily rate-limited. |
| A pump.fun "API" | pump.fun publishes no official public API. No undocumented endpoints are used. |

## Recorded snapshots

Validated observations from the active provider are stored every `OBSERVATION_RECORD_INTERVAL_MS` (default 60 s), tagged with their source. Retention is controlled by `OBSERVATION_RETENTION_ROWS`.

- `GET /api/market/recordings` shows counts per source, and the Backtest panel shows the same.
- Recorded backtests require at least 10 frames. **No history is ever fabricated:** with too few snapshots, the API returns 422 `INSUFFICIENT_DATA`.
