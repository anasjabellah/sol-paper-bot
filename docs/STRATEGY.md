# Strategy analysis

The baseline momentum strategy (`apps/api/src/strategy/momentumStrategy.ts`) is a transparent, deterministic example. **It is not profitable on any evidence available in this repository.**

## Evidence (synthetic data only)

To avoid tuning on the seeds already reported, I evaluated **20 fresh seeds (100–119)**:

```powershell
npm run backtest -- --seeds 100-119 --steps 5000
```

Each seed is 5,000 steps × 5 s, about 7 h of simulated time. Default settings, costs: 1% fee, 0.5% slippage buffer, 0.000105 SOL network fee.

| Metric | Value |
| --- | --- |
| Mean net return (after costs) | **−5.56%** |
| Median net return | −5.25% |
| Profitable seeds | 4 / 20 |
| Mean return with fees and slippage buffer set to zero (AMM impact kept) | **−0.47%** |
| Mean trades per seed | 89.5 |
| Mean fees paid | 0.465 SOL (≈ 4.7% of the 10 SOL account) |

The earlier seeds (1, 2, 3, 7) were also negative: −3.2%, −9.3%, −11.7% and −8.5%.

## Why it loses after costs

1. **The signal has no measurable edge in the simulator.** Without trading costs, the mean result is about −0.5%, roughly zero. Entries require a +3–40% move over 5 minutes. In the simulator, momentum regimes switch at random after 1–7 minutes, so a 5-minute rise says little about the next few minutes. By the time the filter fires, much of the move has often already happened.
2. **The cost per round trip is large relative to the targets.** That cost is about 2 × 1% fee, 2 × 0.5% slippage buffer, about 0.5% AMM impact for a 0.25 SOL order in a ~100 SOL pool, and network fees: roughly **3.5% per round trip**. With ~90 trades, costs alone explain the gap between the −0.5% gross and −5.6% net results.
3. **Payoff asymmetry is not enough.** Take-profit is +25% and stop-loss is −12%. Measured against the fee-inclusive entry, the win rate is about 30–43%. That is too low to overcome the costs when the signal has no edge.

## Decision: defaults unchanged

I deliberately did **not** tune the parameters:

- A no-edge signal on a synthetic random-regime market would only be fitted to the simulator's own random process. That says nothing about real pump.fun markets.
- Real historical data is not available in the repository. No real history has been fabricated.

The tooling for honest evaluation is in place instead:

- `zeroCostNetReturnPct` in every backtest report separates signal quality from cost drag.
- `--seeds A-B` gives multi-seed aggregate evaluation, so an improvement on a handful of seeds is not mistaken for an edge.
- **Real snapshot recording.** Run the API in DexScreener mode and snapshots accumulate. Then run:

  ```powershell
  npm run backtest -- --recorded --source dexscreener
  ```

  The report is labelled "RECORDED REAL MARKET SNAPSHOTS".
- Backtests use next-bar fills (no look-ahead) and count orders that are rejected or cancelled because of missing data.

## A sound process for future improvements

1. Record real snapshots for several days, across different market conditions.
2. Split the data in time: fit on the earlier period and evaluate once on the later, untouched period.
3. Require a positive **zero-cost** return first, then a positive net return, with enough trades to be meaningful.
4. Change one rule at a time, and record what was tried, including failures.
5. Even then, paper results ignore MEV, failed transactions, latency and real queue position. Do not treat them as evidence that real trading would profit.
