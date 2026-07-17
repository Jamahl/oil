# Deploying CrudeSignal Lab (oil-tracker) → oil.roomxvi.com

Instructions for a deployment agent. Target: Hetzner VPS (Ubuntu 22.04/24.04 assumed), app served at `https://oil.roomxvi.com`.

## What this app is

Single-process Node.js/Express server (`server.js`), no build step, serves its own static frontend from `public/`. It fetches free market data (Yahoo, EIA, RSS), calls three paid/keyed APIs (Parallel, OpenRouter, Capital.com demo), writes a prediction journal to **Neon Postgres** (`DATABASE_URL`), and runs a background tick every 5 minutes. Everything runs in one process; model training happens in worker threads (brief 1-core spikes, seconds). Footprint: ~150–250 MB RAM, negligible disk (cache files in `data/`).

**This is a single-user internal tool. It must not be exposed to the public internet unauthenticated** — put HTTP basic auth (or Cloudflare Access) in front of it (step 5).

## 1. Prerequisites

- Node.js **≥ 22.12** (uses built-in `node:sqlite` as a fallback DB and global `fetch`; developed on Node 24). Install via NodeSource or `fnm`.
- Git access to the private repo `github.com/Jamahl/oil` (deploy key or a fine-grained PAT — get from Jamahl).
- Caddy (recommended, automatic TLS) or nginx+certbot.
- Outbound HTTPS must be open (Yahoo, EIA, Google News, oilprice.com, api.parallel.ai, openrouter.ai, demo-api-capital.backend-capital.com, *.neon.tech).

## 2. Install

```bash
sudo mkdir -p /opt/oil-tracker && sudo chown $USER /opt/oil-tracker
git clone git@github.com:Jamahl/oil.git /opt/oil-tracker
cd /opt/oil-tracker
npm ci --omit=dev
```

## 3. Secrets — `/opt/oil-tracker/.env`

`.env` is **gitignored and not in the repo**. Create it with these keys — **get the actual values from Jamahl out-of-band** (they exist in his local `/Users/jam/Projects/oil-tracker/.env`). Never commit this file.

```ini
PARALLEL_API_KEY=…          # parallel.ai search — news lane (optional; app degrades to RSS-only)
OPENROUTER_API_KEY=…        # LLM news scoring + journal insight (optional; degrades to keyword-only)
CAPITAL_API_KEY=…           # capital.com CFD live price (optional; falls back to delayed Yahoo)
CAPITAL_IDENTIFIER=…
CAPITAL_PASSWORD=…
CAPITAL_ENVIRONMENT=demo
DATABASE_URL=postgresql://…@….neon.tech/neondb?sslmode=require   # Neon project rough-unit-12935854; REQUIRED for cloud journal (else local sqlite file)
# PORT=4173                 # default 4173
```

```bash
chmod 600 /opt/oil-tracker/.env
```

## 4. systemd service

`/etc/systemd/system/oil-tracker.service`:

```ini
[Unit]
Description=CrudeSignal Lab (oil-tracker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/oil-tracker
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
# .env is read by the app itself (lib/env.js) — no EnvironmentFile needed,
# but the service user must be able to read /opt/oil-tracker/.env:
# chown www-data /opt/oil-tracker/.env  (or run as a dedicated user)

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data:www-data /opt/oil-tracker/data /opt/oil-tracker/.env
sudo systemctl daemon-reload
sudo systemctl enable --now oil-tracker
journalctl -u oil-tracker -f   # expect: "CrudeSignal Lab -> http://localhost:4173", "ridge + intraday models warm", "journal: +5 logged…"
```

## 5. Reverse proxy + TLS + auth (Caddy)

```bash
sudo apt install caddy
sudo caddy hash-password   # generate <HASH> for the chosen password (get user/pass choice from Jamahl)
```

`/etc/caddy/Caddyfile`:

```
oil.roomxvi.com {
    basic_auth {
        jamahl <HASH>
    }
    reverse_proxy 127.0.0.1:4173
}
```

```bash
sudo systemctl reload caddy
```

Caddy fetches the Let's Encrypt cert automatically once DNS resolves (works with Cloudflare DNS-only *or* proxied — see below; if proxied, Cloudflare SSL mode must be "Full (strict)").

## 6. DNS (roomxvi.com — Cloudflare, personal account)

Add record: `A  oil  <VPS-IPv4>` (+ `AAAA` if the VPS has IPv6).

- **Option A (simplest): DNS-only (gray cloud).** Caddy handles TLS end-to-end. Basic auth is the access control.
- **Option B: proxied (orange cloud).** Set zone SSL to **Full (strict)**; optionally replace basic auth with **Cloudflare Access** (better UX). Don't enable "Always Use HTTPS" until the cert works.

## 7. Firewall

```bash
sudo ufw allow 80,443/tcp
sudo ufw deny 4173/tcp    # app must only be reachable via the proxy
```

## 8. Verify (acceptance checklist)

```bash
curl -s -u jamahl:<pass> https://oil.roomxvi.com/api/price | head -c 200      # expect "source":"capital-cfd" (or yahoo-delayed fallback)
curl -s -u jamahl:<pass> -o /dev/null -w "%{http_code}\n" https://oil.roomxvi.com/api/dashboard   # 200 (first call may take ~10s)
curl -s -u jamahl:<pass> https://oil.roomxvi.com/api/journal | head -c 200    # expect "storage":"neon"
```

Then open the site in a browser: price ticking (LIVE CFD badge), 5 target cards, BUY/HOLD/SELL card, news list (newest first), journal scoreboard. Watch `journalctl -u oil-tracker` for the 5-minute `journal:` lines.

## 9. Updates

```bash
cd /opt/oil-tracker && git pull && npm ci --omit=dev && sudo systemctl restart oil-tracker
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `capital price failed: HTTP 400/401` in logs | Capital.com creds wrong or session issues; app auto-falls back to Yahoo ("delayed" badge). Check `.env` values. |
| News chip "AI off — HTTP 429" | OpenRouter free-model rate limit; harmless, keyword scoring continues. Retry later or configure a different model slug in the UI. |
| `journal: storage sqlite` instead of neon | `DATABASE_URL` missing/unreadable, or Neon unreachable — check `.env` perms and outbound 5432/443 to neon.tech. Journal still works locally. |
| `EIA stocks: FAIL` health chip | eia.gov occasionally slow; refetch with the UI Refresh button. Feature drops out gracefully meanwhile. |
| First dashboard call slow after restart | Models retrain on boot (~1s ridge; forest only if toggled, ~1–2 min in a worker). Normal. |
| High CPU brief spikes | Worker-thread training on refresh — expected, seconds long. |

## Notes for the agent

- No build step, no bundler, no migrations to run — tables auto-create on first boot.
- `data/` is disposable cache (except nothing critical — journal lives in Neon). Safe to delete on disk pressure.
- Keep the server timezone irrelevant: all data timestamps are UTC.
- Licensing: personal-use data sources (Yahoo unofficial API, RSS). Keep this private / single-user; do not make it a public service.
