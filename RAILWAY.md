# Deploying ScopeDesk on Railway (production)

The server (website, API, logins, live connections) runs on Railway. Nobody runs a server on their own computer,
and there are no `.bat` / `.command` launchers for it.

## 1. Deploy
1. Put this project (the folder that contains `server.js`) in a GitHub repository.
2. On railway.com: **New Project > Deploy from GitHub repo** and pick it. `railway.json` already tells Railway how to start it and which health check to use.
3. Open the service > **Settings > Networking > Generate Domain**. You get an address like `https://scopedesk-production.up.railway.app`.

## 2. Save the data (important)
Railway wipes a service's disk on every deploy. Without a Volume every account and task disappears.
1. Service > **Volumes > New Volume**, mount path `/data`.
2. Keep the service at **one replica** (the database is a single SQLite file).

## 3. Variables (Service > Variables)
| Name | Value |
|---|---|
| `JWT_SECRET` | a long random string (run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| `DB_PATH` | `/data/scopedesk.db` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | for password-reset emails (see `.env.example`) |
| `TURN_URLS`, `TURN_SECRET` | recommended: relay for WebRTC between different networks |

The server stops with a clear message if `JWT_SECRET` is missing. Demo accounts are never created in production.
`APP_URL` and CORS are filled in automatically from Railway's domain.

## 4. Check it
Open `https://your-address/api/health`. You should see `{"app":"scopedesk","ok":true,"status":"online"}`.
Then open `https://your-address` and create your first account (Sign up).

## 5. Point the desktop app and agent at it
Edit `public/app-config.json`:
```json
{ "serverUrl": "https://your-address" }
```
Commit and push (Railway redeploys), then build the desktop installer (`cd desktop`, then `npm run dist`). The same file is used by the web page and the host agent.
A custom domain works the same way: put it in `serverUrl`.
