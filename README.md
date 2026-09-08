# Wrike MCP Server

A Model Context Protocol (MCP) server for the [Wrike API v4](https://developers.wrike.com/docs/overview), designed for **organisation-level deployment on the web**: each user connects their **own** Wrike account, and every token and secret stays encrypted at rest and invisible over the wire.

Built with TypeScript, [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (Streamable HTTP transport), Express, and Zod. Tested with Vitest (78 tests) plus an end-to-end smoke script.

## How it works (per-user auth)

```
Admin (once)                    User (self-service)               MCP client (Claude etc.)
──────────                      ────────────────────               ───────────────────────
deploy server with              visits https://host/connect  ───►  Wrike consent page
OAuth app credentials           logs in with THEIR Wrike acct       (Wrike, not this server)
                                ◄── redirected back with code
                                server exchanges code, encrypts
                                user's tokens, shows ONE-TIME
                                connection token (wmc_...)          add server URL +
                                                                    Authorization: Bearer wmc_...
                                                                    → MCP session bound to user
```

- **Nobody shares credentials.** Each user authorizes with their personal Wrike login on Wrike's own pages; the server never sees a password.
- **Users only see their own data.** Every MCP session is bound to one user; tool calls run against that user's Wrike tokens, data-center host included (US/EU resolved per user from Wrike's token response).
- **Self-service lifecycle.** Users connect at `/connect`, get a one-time connection token, and can revoke themselves at `/revoke`.
- Token refresh is automatic and **single-flight per user** (Wrike rotates refresh tokens; concurrent refreshes would lock the user out).

## MCP tools (24)

| Area | Tools |
|---|---|
| Core | `whoami`, `get_account`, `search` |
| Spaces | `list_spaces`, `get_space`, `update_space` |
| Folders | `list_folders`, `get_folder_tree`, `create_folder`, `update_folder`, `delete_folder` |
| Tasks | `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task` |
| Comments | `add_comment`, `list_comments` |
| Timelogs | `create_timelog`, `list_timelogs`, `update_timelog`, `delete_timelog` |
| Attachments | `create_attachment`, `list_attachments`, `get_attachment`, `delete_attachment` |

**Full object support**: `create_task`/`update_task` accept the complete Wrike task object — `dates` (`type`, `start`, `due`, `duration`, `workOnWeekends`), `effortAllocation` (`mode`, `totalEffort`, `allocatedEffort`, `dailyAllocationPercentage`, `responsibleAllocation[]`), custom fields, metadata, responsibles, followers, superTasks, priority, billing type, custom statuses. Schemas mirror the official OpenAPI definitions at developers.wrike.com.

## Setup (admin, once)

```bash
npm install
npm run build
cp .env.example .env   # app-level credentials only — no user tokens
npm start
```

### Configuration

| Variable | Mode | Description |
|---|---|---|
| `PORT` / `HOST` | both | Listen address. Keep `HOST=127.0.0.1` unless behind a TLS-terminating reverse proxy. |
| `AUTH_MODE` | both | `pat` (single-user) or `oauth` (organisation, per-user); auto-detected. |
| `WRIKE_PAT`, `WRIKE_HOST` | pat | Permanent token (single account only). |
| `WRIKE_CLIENT_ID`, `WRIKE_CLIENT_SECRET`, `WRIKE_REDIRECT_URI`, `WRIKE_SCOPES` | oauth | **App** credentials from the Wrike App Console — these identify the app, not any user. `WRIKE_SCOPES` comma-delimited (e.g. `Default,wsReadWrite`). |
| `TOKEN_ENCRYPTION_KEY` | both | 64 hex chars (32 bytes) — AES-256-GCM key for the encrypted token store. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `TOKEN_STORE_PATH` | both | Encrypted store location (default `data/tokens.json`). |

### User flow (oauth mode)

1. User visits `https://your-host/connect` (optionally `?user=their-handle`).
2. They approve access on Wrike's own consent page.
3. The page shows their one-time connection token: `Authorization: Bearer wmc_...`.
4. They paste that into their MCP client (most clients support custom headers on remote MCP servers).
5. Done — all 24 tools now operate on **their** Wrike data.

## Deployment (DigitalOcean droplet, Docker)

A `Dockerfile` + `docker-compose.yml` are included: the app runs as a non-root
user in a minimal image, nginx terminates TLS, and the only published ports are
80/443 on nginx. The app container is reachable solely over the private compose
network.

```bash
# 1. On a fresh Ubuntu droplet, install Docker
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh

# 2. Get the code
git clone <your-repo> /opt/wrike-mcp && cd /opt/wrike-mcp

# 3. Point DNS at the droplet (e.g. wrike.example.com), then get certificates:
#    either copy your existing fullchain.pem/privkey.pem into ./certs/, or on the
#    droplet run once:
sudo apt install -y certbot
sudo certbot certonly --standalone -d wrike.example.com
sudo cp /etc/letsencrypt/live/wrike.example.com/{fullchain,privkey}.pem certs/
# (certs/ and .env are gitignored and dockerignored — they never enter images or the repo)
# For automatic renewal, re-run the copy + `docker compose restart nginx` in a
# monthly cron/systemd timer.

# 4. Configure (app-level credentials only — no user tokens)
cp .env.example .env
nano .env    # WRIKE_CLIENT_ID/SECRET/REDIRECT_URI, TOKEN_ENCRYPTION_KEY

# 5. Launch
docker compose up -d --build

docker compose ps            # wrike-mcp healthy, nginx up
curl https://wrike.example.com/healthz
```

Users then connect at `https://wrike.example.com/connect`.

**Running more MCP servers on the same droplet?** Use the shared-proxy
variant: one nginx container fronts everything by path or subdomain, and each
MCP server attaches to the common network with no published ports of its own.
See [`deploy/README.md`](deploy/README.md) and
`docker-compose.override.shared-proxy.yml.example`.


**Updating**: `git pull && docker compose up -d --build` (the encrypted token
volume survives rebuilds, so users keep their connections).

**What runs where**

| Concern | Handled by |
|---|---|
| TLS, SSE-friendly proxying, 60 MB body limit | nginx container (published 80/443 only) |
| Process isolation, non-root (uid 1001), memory cap | app container on the private network |
| Secrets | `.env` (mounted by compose, never baked into images) |
| Encrypted token store | named volume `wrike-tokens` (AES-256-GCM file only) |
| Restart policy | `unless-stopped` + healthcheck-gated nginx startup |

**Firewall** (optional hardening, since only 80/443 are published anyway):
```bash
ufw allow OpenSSH && ufw allow 443 && ufw allow 80 && ufw enable
```

> Note: sessions and rate limiting are in-memory, so this stack is
> single-instance. For multiple replicas you'd need shared session/rate state
> (or sticky sessions) — one droplet is fine as is.

<details>
<summary>Alternative: bare-metal systemd (no Docker)</summary>

```bash
apt update && apt install -y nginx git curl
adduser --disabled-password mcp
npm ci --omit=dev && npm run build && chown -R mcp:mcp /opt/wrike-mcp
cat >/etc/wrike-mcp.env <<'EOF'
PORT=3000
HOST=127.0.0.1
WRIKE_CLIENT_ID=<app client id>
WRIKE_CLIENT_SECRET=<app client secret>
WRIKE_REDIRECT_URI=https://wrike.example.com/oauth/callback
WRIKE_SCOPES=Default,wsReadWrite
TOKEN_ENCRYPTION_KEY=<64 hex chars>
TOKEN_STORE_PATH=/var/lib/wrike-mcp/tokens.json
EOF
chmod 600 /etc/wrike-mcp.env
systemd unit with NoNewPrivileges/PrivateTmp/ProtectSystem=strict,
then nginx + certbot as in nginx/default.conf but proxying to 127.0.0.1:3000.
```
</details>

## Security model

- **Secrets never touch the repo or users** — the admin's env file holds only app-level OAuth credentials; every user token lives server-side, AES-256-GCM encrypted (`IV ‖ auth-tag ‖ ciphertext`), key never on disk, tamper-detecting, atomic `0600` writes, serialized writes (no concurrent-write races).
- **Connection tokens** (the per-user MCP credentials) are stored **only as HMAC-SHA256 hashes**, compared in constant time, shown to the user exactly once.
- **CSRF-safe OAuth** — HMAC-signed, expiring `state` bound to the pending user; forged/replayed states rejected.
- **No cross-user access** — sessions are bound to a single user at creation; tools run only against that user's client.
- **Secrets never cross the wire** — central `redact()` on all responses; Wrike access/refresh tokens and connection tokens never appear in endpoints, errors, or logs (asserted by tests).
- **Rate limiting** on `/mcp`, `/connect`, `/oauth/callback`, `/revoke`.

## Tests

```bash
npm test                                  # 78 unit/integration tests
node scripts/e2e-peruser.cjs              # end-to-end smoke (build first)
```

Coverage: config validation; token-store crypto (round-trip, tamper, wrong key, 0600, write-queue serialization, multi-user isolation); connection-token hashing/resolution; OAuth state signing/expiry/user-binding; per-user auth manager (multi-user hosts, refresh single-flight per user, isolation between users, revocation); client (per-user bearer/host, 401→refresh→retry, 429 backoff, multipart upload); full-object tool validation; HTTP endpoints via supertest (401/WWW-Authenticate, connect flow with mocked Wrike, revoke, secret-leak assertions).

## Development

```bash
npm run dev        # run via tsx
npx tsc --noEmit   # type-check
```

## Notes

- PAT mode is single-user by nature (one token = one Wrike account); organisation deployments should use OAuth mode.
- If a user's Wrike tokens are revoked in Wrike (password reset, deactivation), that user revisits `/connect`; other users are unaffected.