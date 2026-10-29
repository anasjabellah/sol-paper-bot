# Troubleshooting

### Dashboard shows "Cannot reach the API at http://127.0.0.1:4000"

- Is the API running? Run `npm run dev` from the repository root, then check `Invoke-RestMethod http://127.0.0.1:4000/api/health`.
- Is the API on a different host or port? Set `NEXT_PUBLIC_API_URL` in `apps/web/.env.local` and restart the dashboard. `NEXT_PUBLIC_*` values are baked in at build time, so run `npm run build` again for production.
- Did the API return 403 `CORS_REJECTED`? Add the dashboard origin to `CORS_ORIGINS` in `apps/api/.env`. Note that `http://localhost:3000` and `http://127.0.0.1:3000` are different origins.

### `[config] Refusing to start: unsupported variables present (...)`

A wallet-style or real-trading environment variable is set, either in `apps/api/.env` or in your Windows user or system environment. Remove it:

```powershell
Get-ChildItem Env: | Where-Object Name -Match 'PRIVATE|SEED|MNEMONIC|KEYPAIR|REAL_TRADING|LIVE_TRADING'
Remove-Item Env:NAME_OF_VARIABLE      # current session only; also remove it from System Properties if set there
```

### `Refusing to bind to non-loopback HOST=... without API_AUTH_TOKEN`

Either keep `HOST=127.0.0.1`, or set `API_AUTH_TOKEN` to a random string of at least 24 characters.

### Port already in use (`EADDRINUSE` on 4000 or 3000)

```powershell
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object OwningProcess
Stop-Process -Id <PID>
```

Or change `PORT` in `apps/api/.env`. If you change the dashboard port, also edit the `-p` flag in `apps/web/package.json`.

### `npm install` fails building `better-sqlite3`

Prebuilt binaries exist for Node 20 and 22 on Windows x64. If the install tries to compile:

- Use Node 22 LTS (`node -v`). Very new or odd Node versions may lack prebuilt binaries.
- Check whether a proxy or firewall is blocking the GitHub binary download. If so, install the "Desktop development with C++" workload from the Visual Studio Build Tools, then run `npm install` again.
- As an alternative, use PostgreSQL instead (`DATABASE_URL=postgres://...`). The SQLite module is still installed, but it is only loaded when needed.

### Slow installs or `EPERM` / `EBUSY` errors inside OneDrive folders

OneDrive syncing `node_modules` can lock files. Pause OneDrive sync during `npm install`, or move the project to a non-synced folder such as `C:\dev\solana-paper-bot`.

### Next.js warns "inferred your workspace root ... multiple lockfiles"

A `package-lock.json` exists in a parent folder. `apps/web/next.config.ts` pins `outputFileTracingRoot` to this repository, so the warning should not appear. If it does, check that you are building from this repository.

### Market data status is `degraded` or `down`

- **Mock provider:** check `MOCK_FAILURE_RATE` (it should be `0` unless you are testing failure handling).
- **DexScreener:** check your internet connection. The **Last error** field shows the cause, such as an HTTP 429 rate limit (the app waits for `Retry-After`), a 5xx error, or a network timeout. Polling backs off up to 120 s and recovers automatically.
- While the provider is down, tokens are shown as **stale** and no simulated orders are accepted for them.

### After restarting the API, mock positions show "no live price"

Each API start begins a new mock simulation run with new token IDs. Positions opened in an earlier run have no market data in the new run, so:
- they are held at their last known price minus exit costs;
- they are excluded from live unrealized P&L;
- they cannot be sold.

Use **Reset paper account** to clear them.

**Older versions:** before mock token IDs included a run ID, a restart re-priced these positions on an unrelated path and could trip the drawdown emergency stop. If that happened, press **Reset kill switch**.

### Switching to DEXSCREENER (or back to MOCK) is refused

| Error | Cause and fix |
| --- | --- |
| `BOT_RUNNING` | The bot is running. Press **■ Stop** first. |
| `POSITIONS_FROM_OTHER_SOURCE` | Positions opened on the other data source are still open. A `mock_…` position cannot be priced or sold with real data. Sell those positions (Manual paper order → SELL, 100%), or use **Reset paper account**, then switch. |

### I set `MARKET_PROVIDER=dexscreener` in .env but the dashboard still shows MOCK

A provider chosen in the dashboard is stored in the database and takes precedence over the env default. `GET /api/status` → `providerSelectedBy: "dashboard"` confirms this. Use the dashboard selector to switch.

### Many PumpSwap tokens show "quoted price disagrees with reserve-implied price"

DexScreener's reported reserves for these pairs imply a price noticeably different from its quoted price. Above 15% disagreement, a fill price cannot be modelled responsibly, so the token is observation-only. This is a data-quality limitation, not a bug.

### With DexScreener, every token is skipped with "liquidity unavailable"

This is expected for tokens still on the pump.fun bonding curve: DexScreener returns no reserve data for `dexId: pumpfun`. Only graduated PumpSwap pairs carry reserves. See the README section "Using real (read-only) market data".

### The bot is running but never buys

Open **Logs → All decisions** and expand a SKIP entry. Every failed rule is listed with its value and threshold. Also check:

- **Bot control → "New buys blocked"**: daily loss, drawdown or max positions.
- The kill switch.
- Cooldowns after exits.

### "Emergency stop is active. Reset it before starting the bot."

Press **Reset kill switch** in the dashboard, or run:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/bot/reset-kill-switch -ContentType application/json -Body '{"confirm":"RESET"}'
```

If the reason mentions drawdown, it was tripped automatically. Review your risk settings or reset the paper account.

### Start completely fresh

Stop the API, then delete the SQLite database:

```powershell
Remove-Item apps/api/data -Recurse -Force
```

Or use **Reset paper account** in the dashboard (the bot must be stopped).

### PostgreSQL test is skipped

It runs only when `TEST_DATABASE_URL` is set. See the README "PostgreSQL" section. The Docker container listens on host port **55432**.

### Docker: `api` container exits immediately

Inside containers the API binds `0.0.0.0`, which requires `API_AUTH_TOKEN` of at least 24 characters. Put it in a `.env` file next to `docker-compose.yml` (see SETUP_WINDOWS.md §7).
