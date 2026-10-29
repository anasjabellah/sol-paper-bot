# On-chain event recorder (Helius): Phase 2A prototype

Status: **prototype, not production-ready.** It has never run against Helius with a real key, and the `recordings.db` v2 migration has not been applied.

- Code: `apps/api/src/onchain/`
- Tests: `apps/api/test/onchain.test.ts` and `onchain-lifecycle.test.ts`. All fixtures are synthetic and live in `onchain-fixtures.ts`.

The recorder is read-only. It holds no wallet or key material, never signs, sends or builds transactions, and runs no strategy or paper fills.

## Commands

| Command | Effect |
| --- | --- |
| `npm run onchain` | Same as `check`. This is the default: it validates the config and the pinned IDLs, lists the endpoints a session would contact, opens no database and makes no network call. |
| `npm run onchain:report [-- --json]` | Read-only report covering events, quarantine, watchlist, pools, errors, gaps and usage. |
| `npm run onchain -- record --live --max-minutes N` | Records from the real services. Needs `HELIUS_API_KEY` (exits 3 without it) and a database already at schema v2. |
| `npm run onchain -- record --live --migrate ...` | Applies the additive v2 tables first. The CLI refuses without `--migrate` if the database is at v1, and also refuses to create a new database file. |

### Network gate (exit 6)

A remote endpoint (any non-loopback `HELIUS_WS_URL`, `HELIUS_RPC_URL` or `DEXSCREENER_BASE_URL`) is contacted only when both of these hold:

1. `--live` is passed.
2. The process is not under a test runner (`VITEST`, `NODE_ENV=test` or `ONCHAIN_FORBID_NETWORK=true`).

Without `--live`, only loopback endpoints (a local test server) are allowed. This holds whatever the API key looks like: a fake key with the default URLs is refused before anything is opened.

In the test suite, `test/setup-network-guard.ts` additionally replaces the global `fetch` and `WebSocket` with loopback-only versions. It also sets `ONCHAIN_FORBID_NETWORK`, which child processes inherit.

This gate was added after a manual verification command in the previous round connected to the real Helius WebSocket with a fake key. The cause was a mistyped database path.

## Data flow

| Stage | Behaviour |
| --- | --- |
| Watchlist | `onchain_watchlist` holds static mints (`ONCHAIN_WATCHLIST`, never evicted) and mints discovered from DexScreener (see Discovery below). |
| Live | One WebSocket. Each active mint gets `logsSubscribe {mentions:[mint]}` at `confirmed` commitment. Mints are added and removed at runtime. Every pump buy, sell, complete and migrate instruction, and every PumpSwap buy and sell, lists the mint (`base_mint`) account, so one subscription follows a token from bonding curve to PumpSwap. There are no program-wide subscriptions; the old option is rejected. |
| Keepalive | A JSON-RPC `ping` every `ONCHAIN_KEEPALIVE_MS` (default 60 s), as Helius recommends "pings every minute" against its 10-minute inactivity timer. `ws.ping()` is also sent when the socket supports it; Node's built-in WebSocket does not. If Helius answers `ping` with an error, the message still counts as two-way traffic, and the recorder logs this once. A watchdog drops the connection after `ONCHAIN_STALE_AFTER_MS` (default 150 s) with no inbound message, opens gaps, reconnects and backfills. |
| Decoding | Events come from `Program data:` log lines, attributed to the program on top of the invoke stack. Failed transactions are skipped. |
| Truncated logs | The recorder calls `getTransaction` and decodes the self-CPI inner instructions (Anchor `emit_cpi`, tag `e445a52e51cb9a1d`). |
| Deduplication | `chain_events UNIQUE(signature, payload_hash, occurrence)`. A log copy and a CPI copy of the same event merge into one row. Duplicate notifications across subscriptions are ignored. A signature already recorded completely is never fetched again. |
| Pinned layouts | The IDLs come from `@pump-fun/pump-sdk@4.3.1` (see `src/onchain/idl/PROVENANCE.md`). Only exact layout matches are stored; anything else goes to `onchain_quarantine` or `onchain_errors`. |
| Exact amounts | u64, i64, u128 and i128 values are stored as exact decimal strings in raw base units. |

## Discovery and lifecycle

**Discovery.** Every `ONCHAIN_DISCOVERY_INTERVAL_MS` (default 120 s), the existing read-only `DexScreenerProvider` reports pumpfun and pumpswap tokens. These become watchlist candidates.

- Candidates are deduplicated and invalid addresses are dropped.
- New mints enter as `pending` and are activated newest pair first, up to `ONCHAIN_MAX_ACTIVE` (default 20, at most 50).

**Eviction.**

- **Idle.** A discovered mint is evicted when it has had neither a discovery report nor an on-chain event for `ONCHAIN_WATCH_IDLE_MINUTES` (default 60).
- **Capacity pressure.** When the watchlist is full, the least active discovered mint is evicted, but only after it has been watched for `ONCHAIN_MIN_WATCH_MINUTES` (default 15).
- **Static mints** are never evicted, and adding static mints sheds discovered ones.
- **On every eviction**, the mint is unsubscribed, its open gap ends with the note "address unwatched", and its cursor is dropped. The unwatched time is therefore never presented as a recoverable gap.

**Coverage.** Each active stretch is an `onchain_watch_periods` row. A mint is covered only inside its watch periods, from `first_subscribed_at`, minus recorded gaps. There is no backfill of history from before a mint was first watched.

**Lifecycle.** The stages are `bonding_curve`, `complete` and `migrated`, plus `pool`.

- DexScreener's `dexId` is recorded as `dexscreener_reported` only.
- On-chain evidence replaces it: `TradeEvent`, `CompleteEvent`, `CompletePumpAmmMigrationEvent`, `CreatePoolEvent`, PumpSwap trades, or a verified pool account.
- Among on-chain evidence the lifecycle only advances.

## PumpSwap pool to mint resolution

PumpSwap `BuyEvent` and `SellEvent` carry neither the mint nor the quote mint. `onchain_pools` resolves them from on-chain evidence only:

| Method | Evidence |
| --- | --- |
| `onchain_event` | `CreatePoolEvent` (base and quote mint) or `CompletePumpAmmMigrationEvent` |
| `instruction_accounts` | A PumpSwap swap instruction in a fetched transaction: `pool`, `base_mint` and `quote_mint` at the account positions declared by the pinned IDL. Discriminators are checked against `sha256("global:<name>")`. |
| `pool_account` | `getAccountInfo(pool)`. The owner must be the PumpSwap program and the data must start with `sha256("account:Pool")[0..8]`. `base_mint` and `quote_mint` are read at fixed offsets after `pool_bump`, `index` and `creator`. Costs 1 credit, at most once per pool. |

**Pool statuses.**

| Status | Meaning |
| --- | --- |
| `resolved` | On-chain evidence gives the base and quote mint. |
| `unresolved` | Retryable: an RPC error, or the budget ran out (which does not count as an attempt). Up to 3 attempts, at least 10 min apart. |
| `unresolvable` | Wrong owner, wrong discriminator, account not found, or implausible data. |
| `conflict` | Two methods disagree. The status is sticky and the pool is never used. |

**Use of the result.**

- A DexScreener pumpswap pair address is only a hint that triggers verification.
- The pool attaches to the base mint found on-chain, never to the hinted mint.
- `chain_events` rows are never rewritten. The view `chain_events_resolved` adds `resolved_mint`, `resolved_mint_source` and `resolved_quote_mint`, so later resolutions show up there.

## Quote denomination

- `quote_asset = 'SOL'` only when `quote_mint` is native SOL (`1111…`) or wrapped SOL. Any other mint gives `OTHER`; an unknown mint gives `NULL`.
- No column name implies SOL.
- pump `TradeEvent` uses the `quote_*` fields. A USDC-quoted live trade was observed with `sol_amount = 0`.
- PumpSwap quote mints come only from a resolved pool.
- `CompletePumpAmmMigrationEvent.sol_amount` is mapped to `quote_amount` only for SOL quotes.

## Gaps, backfill and budget

**Gap kinds.** `disconnect`, `budget_pause` and `between_sessions`. Each gap records the last signature seen before it.

**Backfill.** `getSignaturesForAddress(until = last signature)` with `before` pagination, capped at `ONCHAIN_BACKFILL_MAX_SIGNATURES` (default 200), then `getTransaction` for each transaction that isn't already recorded. Fetched transactions also feed pool resolution through their instruction accounts.

**Gap statuses.**

| Status | Meaning |
| --- | --- |
| `backfilled_verified` | The listing reached `until`, and every listed transaction was fetched and fully decoded. |
| `backfill_partial` | The cap was reached, the budget ran out, the recorder stopped, or a fetch or decode failed. |
| `backfill_failed` | The listing itself failed. |
| `unverifiable` | No signature was seen before the gap. |
| `open` | Not backfilled: backfill is disabled, or the address is no longer watched. |

**Reconnection.** Exponential backoff with jitter: base 1 s, cap 60 s.

- A failed connection reported only through `error` (Node 22), a 30 s connect timeout, the stale watchdog and a rejected `logsSubscribe` all lead to one handling path: open gaps, then reconnect.
- If a subscription is removed while its request is still in flight, the recorder unsubscribes as soon as the server confirms it.
- Subscriptions added during a budget pause are applied on resume.

**Budget.** `onchain_usage` is persisted per UTC day.

- RPC calls, including retries, are reserved before they are sent.
- WebSocket bytes are counted in both directions (conservative).
- The socket closes as soon as a daily limit is reached and resumes after the UTC day rolls over. On the monthly limit the recorder stops.
- Overshoot is at most one message or one response.
- Credits are an estimate; the Helius dashboard is authoritative.

**Key handling.** The key exists only in the request URLs. Every logged or stored message and `config_json` are redacted, and the network-gate errors name hosts only.

## Remaining limitations

1. **New tokens are discovered late.** Newness comes from DexScreener's discovery endpoints, which lag on-chain creation; the delay hasn't been measured. A token's `CreateEvent` is usually missed, because the subscription starts after creation.
2. **The `ping` keepalive is unverified on standard WebSockets.** Helius documents a JSON-RPC `ping` only for Parsed Streams. Whether `ping` (or its error reply) resets the idle timer on standard WebSockets hasn't been checked against Helius. The stale watchdog limits the damage to a gap plus a backfill.
3. **Mint used as a quote.** A watched mint used as the quote of another pool also matches `mentions`. Those events are stored under their own mint and pool.
4. **Backfill caps.** Very active mints can hit the backfill cap, so their gaps end `backfill_partial`.
5. **Reserve semantics.** Reserves are stored as emitted. Whether they are pre- or post-trade isn't asserted.
6. **Pool layout risk.** Pool-account decoding relies on the stable leading fields of the pinned `Pool` layout. A future change to that prefix would be caught at IDL load (layout-prefix check), but not on-chain until re-pinning.

## Expected usage (estimates, not measured)

These figures assume about 3 KB per `logsNotification`, 2 credits per 100 KB, 1 credit per connection and 1 per RPC call.

| Item | Estimate |
| --- | --- |
| Keepalive | About 150 B/min per connection, under 1 credit/day |
| 10 watched mints at 5 tx/min each | About 216 MB/day, about 4.3k credits/day |
| 20 active mints (the default cap) at 10 tx/min each | About 860 MB/day. The default 300 MB/day cap pauses it after about 8 h. Lower `ONCHAIN_MAX_ACTIVE` or raise the caps deliberately. |
| Pool lookups | 1 credit per newly seen PumpSwap pool, plus up to 2 retries |
| Backfill | At most about 1 + cap credits per gap per mint; 201 at the defaults |
| DexScreener discovery | Uses DexScreener's free API, not Helius credits. Its rate limits are shared with the live app and the DexScreener recorder. |
