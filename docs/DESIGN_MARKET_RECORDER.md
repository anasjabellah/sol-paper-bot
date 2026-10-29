# Market-data recorder: design and implementation status

Status: **implemented** in `apps/api/src/recorder/`. Start it with `npm run record`; get the quality report with `npm run record:report`. Tests: `apps/api/test/recorder.test.ts`.

## Deviations from the original design

| Design item | Status |
| --- | --- |
| `raw_pairs` table | **Deferred.** The provider is reused unchanged and does not expose raw HTTP payloads. Malformed-pair counts are kept in each poll's `warnings_json`. |
| Per-poll HTTP request and error counts | **Partial.** The poll status (`ok`, `cached`, `failed`), error, `rate_limited_until` and provider warnings are recorded. Exact request counts are not available. |
| Size cap and daily `VACUUM` | **Replaced.** Retention by age (`RECORDER_RETENTION_DAYS`, pruned every 6 h) plus a warning above `RECORDER_MAX_DB_MB`. There is no automatic `VACUUM`, because it rewrites the whole file and blocks writes. |
| Additions | A `gaps` table (within-run `poll_gap` and `between_runs`), typed columns alongside `payload_json`, and an optional `--keep-awake` flag (Windows). |

## Operating it

| Task | Command or action |
| --- | --- |
| Start | `npm run record` from the repository root, or `npm run record -- --keep-awake` to ask Windows not to sleep while it runs. The window must stay open. |
| Stop | Ctrl+C in that window. The run is marked as cleanly stopped. A forced kill leaves the run without `stopped_at`, which the report flags. |
| Quality report | `npm run record:report` (text) or `npm run record:report -- --json`. It opens the database read-only, so it is safe while recording. |
| Database location | `apps/api/data/recordings.db` (Git-ignored), separate from `paper.db` |

## Goal

Collect a continuous, high-resolution history of DexScreener observations for out-of-sample strategy research. It must not touch the live paper account, the running API, or `apps/api/data/paper.db`.

## Process and isolation

- **Separate entry point:** `npm run record` → `apps/api/src/recorder/cli.ts`, a separate Node process. It never starts Fastify or the bot, and never imports the order, portfolio or settings services.
- **Separate database:** it writes **only** to its own SQLite file, default `apps/api/data/recordings.db`, configurable via `RECORDER_DATABASE_URL`.
- **Guard:** it refuses to start if that path resolves to the paper database. It never opens `paper.db`.
- **Reuse:** it reuses `DexScreenerProvider`, `mapPair` and `MarketObservationSchema` unchanged, so recorded data passes exactly the validation the live app applies.
- **No secrets:** no wallet, keys or transactions, and only GET requests.

## Rate limits and polling

| Endpoint | Documented limit | Recorder budget |
| --- | --- | --- |
| `/tokens/v1/solana/{≤30}` | 300/min | 1 request per 30 tracked tokens every 15 s, i.e. 8 req/min for 60 tokens |
| Discovery lists (4 endpoints) | 60/min each | 4 requests every 60 s |
| `/latest/dex/search` | 300/min | 1 request every 60 s |

- The recorder and the live app share DexScreener's per-IP limits. Combined usage at the defaults is about 30 req/min, well under the documented limits.
- On HTTP 429 it backs off and honours `Retry-After`.
- **Poll interval:** 15 s by default, minimum 10 s.
- **Watchlist:** a fixed watchlist (env) of tokens to follow continuously, plus discovery, capped at `RECORDER_MAX_TRACKED`. The fixed list gives contiguous series; discovery adds breadth.

## Timestamps (stored separately, never conflated)

| Column | Meaning |
| --- | --- |
| `fetched_at` | When the HTTP response was received |
| `poll_started_at` | When the poll began (all rows from one poll share it) |
| `source_ts` | Always NULL for DexScreener, which gives no per-record timestamp |
| `pair_created_at` | Token age only; never treated as an update time |

## Schema (SQLite)

```sql
recorder_runs(id TEXT PK, started_at, stopped_at, version, config_json)
polls(id TEXT PK, run_id, poll_started_at, finished_at, http_requests, http_errors, rate_limited, tokens_requested, tokens_returned, warnings_json)
observations(id TEXT PK, poll_id, mint, fetched_at, poll_started_at, source_ts NULL, payload_json)   -- validated MarketObservation
raw_pairs(id TEXT PK, poll_id, mint, fetched_at, raw_json)   -- optional, size-capped, for mapping audits
rejections(id TEXT PK, poll_id, mint, reason, raw_json)      -- schema/validation failures
INDEX observations(mint, fetched_at); INDEX observations(poll_started_at)
```

## Retention

- Keep validated observations for `RECORDER_RETENTION_DAYS` (default 30).
- Keep raw pairs for 3 days, pruning daily.
- Cap the database file at `RECORDER_MAX_DB_MB`. The oldest raw data is pruned first, then the oldest observations.
- Use WAL mode with a daily `VACUUM`.

## Data-quality checks (recorded per poll, reported by `npm run record:report`)

| Check | Purpose |
| --- | --- |
| Gaps: missing polls, longest gap per token | Mark series as non-contiguous so backtests can split around gaps |
| Duplicate or out-of-order `fetched_at` per mint | Detect clock or ordering problems |
| Unchanged market fields across N consecutive polls | Possible source caching |
| Quote vs reserve-implied gap distribution; share beyond 15% | Track how often prices are unusable |
| Null rates per field; implied SOL/USD consistency across tokens | Mapping sanity check |
| Rate-limit hits and HTTP error rates | Keep usage within limits |

## Use in research

- **Chronological splits:** fit on days 1–4, validate on day 5, test once on days 6–7.
- **Replay resolution:** replay at the recorded 15 s resolution, not 60 s.
- **Pre-registration:** metrics (net return after costs, zero-cost return, drawdown, trade count) are fixed before looking at the test period.
- **Reporting:** results are labelled "recorded real snapshots", never as live or paper performance.

## Tests to write with the implementation

- Refuses to start when the target is `paper.db`.
- Never issues non-GET requests, and only to documented paths.
- Respects the rate budget and 429 back-off (fake clock and fake fetch).
- Timestamps are distinct and monotonic per mint.
- Retention pruning keeps the newest rows.
- The quality report flags injected gaps, duplicates and unchanged-field runs.
