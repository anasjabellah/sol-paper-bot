# Windows 10/11 setup (PowerShell + VS Code)

## 1. Install prerequisites

1. **Node.js 22 LTS** (x64) from <https://nodejs.org>. Accept the defaults. You do *not* need the "native modules tools" option.
2. **VS Code** from <https://code.visualstudio.com>. When you open the folder, it suggests the recommended extensions: ESLint, Tailwind CSS and Vitest.
3. Optional: **Docker Desktop**, only for PostgreSQL or the container stack.

Verify in a new PowerShell window:

```powershell
node -v    # v22.x (v20.19+ also works)
npm -v     # 10.x
```

## 2. Install dependencies

```powershell
cd C:\path\to\solana-paper-bot
npm install
```

This installs every workspace (API, dashboard, shared package) from the root.

## 3. (Optional) configure

The app runs with safe defaults and **no configuration**. To change settings:

```powershell
Copy-Item .env.example apps/api/.env
notepad apps/api/.env
```

Never put private keys, seed phrases or wallet files anywhere in this project. The API refuses to start if it sees variables like `PRIVATE_KEY`, `SEED_PHRASE`, `MNEMONIC` or `REAL_TRADING`.

To point the dashboard at a different API URL:

```powershell
Set-Content -Path apps/web/.env.local -Value "NEXT_PUBLIC_API_URL=http://127.0.0.1:4000" -Encoding utf8
```

## 4. Run (development)

```powershell
npm run dev
```

- Dashboard: <http://127.0.0.1:3000>
- API health: <http://127.0.0.1:4000/api/health>

Check it from PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/health
```

Stop with `Ctrl+C`. The bot starts **stopped**. Use **▶ Start** in the dashboard, or:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4000/api/bot/start
```

Emergency stop:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/bot/emergency-stop -ContentType application/json -Body '{"reason":"manual"}'
```

## 5. Test, type-check, lint, build

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm start          # runs the production builds (API :4000, web :3000)
```

## 6. Optional: PostgreSQL via Docker

```powershell
npm run docker:db
Add-Content apps/api/.env "DATABASE_URL=postgres://paperbot:paperbot@127.0.0.1:55432/paperbot"
npm run dev
```

The container is published on **55432** so it does not collide with a locally installed PostgreSQL on 5432.

## 7. Optional: full Docker stack

Create a `.env` file next to `docker-compose.yml` with a long random token. Inside a container, the API must bind `0.0.0.0`, and it refuses to do so without a token:

```powershell
$token = -join ((48..57) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
Set-Content -Path .env -Value "API_AUTH_TOKEN=$token" -Encoding utf8
npm run docker:up
```

Ports are published on `127.0.0.1` only. Stop with `npm run docker:down`.

## Where data lives

- SQLite database: `apps/api/data/paper.db`. It is git-ignored. Delete the file (with the API stopped) to start completely fresh, or use **Reset paper account** in the dashboard.
- Docker PostgreSQL: the named volume `solana-paper-bot_pgdata`.
