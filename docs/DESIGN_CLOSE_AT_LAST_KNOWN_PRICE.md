# Design note: "close at last known price" (NOT IMPLEMENTED)

Status: **proposal only**. Nothing in the codebase implements it. It must be reviewed before any code is written.

## Problem

A position can become permanently unpriceable:

- a mock token from an earlier simulation run (mock token IDs are unique per run), or
- a real token the provider no longer returns.

Such a position cannot be sold, because every simulated fill must be justified by a fresh observation with usable pool reserves. It sits in the portfolio at its last known value until the paper account is reset.

## Why this cannot be a normal SELL

A normal SELL is a *simulated fill*: priced from current reserves, subject to risk checks, and audited as `order.filled`. There is no current market for these positions. Recording a SELL would claim an execution the simulation cannot justify, which the safety rules prohibit. The action must therefore be an **explicit, manual, clearly labelled write-off**, never a fill.

## Proposed semantics

| Aspect | Proposal |
| --- | --- |
| Trigger | Manual only (dashboard button or `POST /api/positions/{mint}/write-off`), with `{"confirm":"WRITE_OFF"}`. Never automatic, never done by the bot. |
| Eligibility | Only positions whose valuation method is `last-known-price` (no observation from the active provider) for at least N minutes. Refused for positions with a fresh price: those must use a normal SELL. Refused while the kill switch is active? No. A write-off reduces risk, so it is allowed, but it is audited. |
| Proceeds | Default **0 SOL** (conservative: no market to sell into). Optional alternative: last known price × quantity × (1 − slippage buffer) × (1 − trading fee) − network fee, i.e. the value currently shown in equity. This is the main decision to make. Using the shown value means equity does not jump; using 0 realizes the worst case. |
| Accounting | Cash += proceeds. Realized P&L += proceeds − remaining cost basis. Fees += 0. The position row is deleted. The post-exit cooldown applies as for any exit. |
| Record type | A new record type, `WRITE_OFF`, with `status: "WRITTEN_OFF"`. It is not a FILLED order, and it is excluded from trade statistics (win rate, fills, backtest comparisons). |
| Audit | `position.written_off` at level `warn`, recording: mint, symbol, quantity, cost basis, proceeds, the proceeds basis (`zero` or `last-known-price@<timestamp>`), the reason, and the time since the last price. |
| Idempotency | Keyed by `clientOrderId`, like orders. A second request returns the first result. |
| Display | Shown in a separate "write-offs" list and labelled "not a market execution". |

## Open questions for review

1. Default proceeds: zero (conservative) or the last-known value shown in equity (continuity)?
2. Minimum time without a price before a write-off is allowed.
3. Whether write-offs count toward the daily-loss limit. Proposed: yes, they are realized losses.
