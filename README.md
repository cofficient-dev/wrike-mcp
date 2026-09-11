# Wrike MCP Server

A Model Context Protocol (MCP) server for the [Wrike API v4](https://developers.wrike.com/docs/overview), designed for **organisation-level deployment on the web**: each user connects their **own** Wrike account, and every token and secret stays encrypted at rest and invisible over the wire.

Built with TypeScript, [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (Streamable HTTP transport), Express, and Zod. Tested with Vitest (114 tests) plus an end-to-end smoke script.

## How it works (per-user auth)

```
Admin (once)                    User (self-service)               MCP client (Claude etc.)
──────────                      ────────────────────               ───────────────────────
deploy server with              visits <host>/wrike/connect  ───►  Wrike consent page
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

## MCP tools (26)

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
| `PUBLIC_BASE_URL` | oauth | Public origin exactly as MCP clients see it, including any path prefix and no trailing slash — normally `https://mcp.example.com/wrike` (one host, one path per MCP server). A server on its own hostname uses the bare origin, `https://wrike.example.com`. Enables MCP-native OAuth sign-in (see below). |

### User flow (oauth mode)

**Header-token flow (any MCP client):**
1. User visits `https://mcp.example.com/wrike/connect` (optionally `?user=their-handle`).
   A handle that is already connected is refused with 409 — pick another, or
   revoke the existing connection first, since reusing it would repoint every
   connection token already issued for that handle at the new Wrike account.
2. They approve access on Wrike's own consent page.
3. The page shows their one-time connection token: `Authorization: Bearer wmc_...`.
4. They paste that into their MCP client (most clients support custom headers on remote MCP servers).
5. Done — all 26 tools now operate on **their** Wrike data.

### Native sign-in (no token copying)

With `PUBLIC_BASE_URL` set, the server exposes the MCP OAuth discovery and
authorization endpoints (`/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/oauth/authorize`, `/oauth/token`,
`/oauth/register`, `/oauth/revoke-token`). Metadata is served both at those
paths and at the RFC 8414 §3.1 / RFC 9728 §3.1 issuer-suffixed form
(`/.well-known/oauth-authorization-server/<issuer path>`) — behind a
path-prefixed proxy that form is host-rooted and needs its own proxy route, so
see [`deploy/README.md`](deploy/README.md). MCP clients like Claude then
handle everything in-app:
the user clicks Connect, confirms which MCP client is asking on this server's
consent screen, approves on Wrike's consent page, and the client receives the
token itself — same per-user storage and isolation, no `wmc_...` pasting.

Registration is open (any client may self-register via DCR), so the consent
screen names the requesting client and its redirect URI before the user reaches
Wrike. `client_name` is supplied by the client and is **not** verified — it is
shown so the user can spot a client they did not start, and the screen says so.
Confirming the screen posts to `/connect/confirm`; the flow cannot be skipped
by a cross-site form (see Security model).

**Claude setup:** Settings → Connectors → Add custom connector →
URL `https://mcp.example.com/wrike/mcp` (or `https://wrike.example.com/mcp` if
the server has its own hostname) → Authentication **"Always required"** →
OAuth client **"No client ID — register one automatically"** (dynamic client
registration). The user signs in through the browser once and is done.

The header-token flow above keeps working in parallel for clients without
OAuth support.

## Deployment (DigitalOcean droplet, Docker)

**Recommended layout:** one host with a shared proxy, one path per MCP server
(`https://mcp.example.com/wrike`, `https://mcp.example.com/github`, …), so
adding a server is a route rather than a new certificate. That layout — and the
`PUBLIC_BASE_URL`, `WRIKE_REDIRECT_URI` and `/.well-known/` proxy routes it
needs — is in [`deploy/README.md`](deploy/README.md).

The walkthrough below is the simpler case: this server alone on its own
hostname, with the bundled proxy. Swap `wrike.example.com` for your own.

A `Dockerfile` + `docker-compose.yml` are included: the app runs as a non-root
user in a minimal image, Caddy terminates TLS and obtains its own certificate
from Let's Encrypt, and the only published ports are 80/443 on Caddy. The app
container is reachable solely over the private compose network.

```bash
# 1. On a fresh Ubuntu droplet, install Docker
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh

# 2. Get the code
git clone <your-repo> /opt/wrike-mcp && cd /opt/wrike-mcp

# 3. Point a DNS A record at the droplet, then set the hostname and ACME
#    email in the Caddyfile (both are placeholders in the checked-in copy):
nano Caddyfile    # wrike.example.com, admin@example.com

# 4. Configure (app-level credentials only — no user tokens)
cp .env.example .env
nano .env    # WRIKE_CLIENT_ID/SECRET/REDIRECT_URI, TOKEN_ENCRYPTION_KEY, PUBLIC_BASE_URL

# 5. Launch — Caddy gets the certificate on first start
docker compose up -d --build

docker compose ps            # wrike-mcp healthy, caddy up
curl https://wrike.example.com/healthz
```

There is no certbot step and no renewal timer: Caddy renews automatically.
Certificates live in the `caddy-data` volume, so keep it across rebuilds.

Users then connect at `https://wrike.example.com/connect`.

**Running more MCP servers on the same droplet?** Use the shared-proxy layout
described above: one Caddy container fronts everything by path, and each MCP
server attaches to the common network with no published ports of its own.
See [`deploy/README.md`](deploy/README.md),
[`deploy/caddy/`](deploy/caddy/) and
`docker-compose.override.shared-proxy.yml.example`.


**Updating**: `git pull && docker compose up -d --build` (the encrypted token
volume survives rebuilds, so users keep their connections).

**What runs where**

| Concern | Handled by |
|---|---|
| TLS (automatic Let's Encrypt), SSE-friendly proxying, 60 MB body limit | Caddy container (published 80/443 only) |
| Process isolation, non-root (uid 1001), memory cap | app container on the private network |
| Secrets | `.env` (mounted by compose, never baked into images) |
| Encrypted token store | named volume `wrike-tokens` (AES-256-GCM file only) |
| Restart policy | `unless-stopped` + healthcheck-gated Caddy startup |
| Certificates | named volume `caddy-data` (renewed automatically) |

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
apt update && apt install -y caddy git curl
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
then Caddy as in ./Caddyfile but with `reverse_proxy 127.0.0.1:3000`.
```
</details>

## Security model

- **Secrets never touch the repo or users** — the admin's env file holds only app-level OAuth credentials; every user token lives server-side, AES-256-GCM encrypted (`IV ‖ auth-tag ‖ ciphertext`), key never on disk, tamper-detecting, atomic `0600` writes, serialized writes (no concurrent-write races).
- **Connection tokens** (the per-user MCP credentials) are stored **only as HMAC-SHA256 hashes**, compared in constant time, shown to the user exactly once.
- **CSRF-safe OAuth** — HMAC-signed, expiring `state` bound to the pending user; forged/replayed states rejected.
- **MCP client consent** — registration is open (DCR), so `/connect` shows which client is asking, with its `client_id` and redirect URI, before the user reaches Wrike; `client_name` is client-supplied and shown as unverified. Confirmation carries a nonce bound to a `SameSite=Lax` cookie, `__Host-` prefixed over HTTPS, so the screen survives both a cross-site auto-submitted form and a cookie planted from a sibling subdomain.
- **No handle takeover** — user slots are claimed atomically; a handle that is already connected is refused (409) rather than overwritten, since overwriting would repoint connection tokens already issued for it at another person's Wrike account.
- **Codes and tokens** — authorization codes are single-use, short-lived and PKCE-bound (S256 required); token responses and the one-time token page send `Cache-Control: no-store`.
- **No cross-user access** — sessions are bound to a single user at creation; tools run only against that user's client.
- **Secrets never cross the wire** — central `redact()` on all responses; Wrike access/refresh tokens and connection tokens never appear in endpoints, errors, or logs (asserted by tests).
- **Rate limiting** on every public endpoint: `/mcp`, `/connect`, `/connect/confirm`, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke-token`, `/oauth/callback`, `/revoke`.

## Tests

```bash
npm test                                  # 114 unit/integration tests
node scripts/e2e-peruser.cjs              # end-to-end smoke (build first)
```

Coverage: config validation; token-store crypto (round-trip, tamper, wrong key, 0600, write-queue serialization, multi-user isolation); connection-token hashing/resolution; OAuth state signing/expiry/user-binding; per-user auth manager (multi-user hosts, refresh single-flight per user, isolation between users, revocation); client (per-user bearer/host, 401→refresh→retry, 429 backoff, multipart upload); full-object tool validation; HTTP endpoints via supertest (401/WWW-Authenticate, connect flow with mocked Wrike, revoke, secret-leak assertions); MCP-native OAuth (discovery at both metadata locations, DCR validation, PKCE, single-use codes, resource indicators, error-redirect vs JSON, consent screen and its nonce cookie, handle-collision races, revocation); and redaction of both shape-matched and registered literal secrets.

## Development

```bash
npm run dev        # run via tsx
npx tsc --noEmit   # type-check
```

## Notes

- PAT mode is single-user by nature (one token = one Wrike account); organisation deployments should use OAuth mode.
- If a user's Wrike tokens are revoked in Wrike (password reset, deactivation), that user revisits `/connect`; other users are unaffected.