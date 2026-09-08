# Running multiple MCP servers on one host

Docker is designed for exactly this: **each MCP server is its own compose
project** with its own network, volumes, credentials, and restart policy. They
share only host RAM (a server like wrike-mcp uses ~100–200 MB, so a 2 GB droplet
comfortably runs 3–5).

## Recommended layout: one shared proxy

```
/opt/mcp-proxy/                 ← deploy/proxy (owns ports 80/443, one cert)
/opt/wrike-mcp/                 ← this project
/opt/github-mcp/                ← any other MCP server
/opt/jira-mcp/                  ← ...
```

The shared nginx routes by path or subdomain to each server on the common
`mcp-proxy` Docker network:

```
https://mcp.example.com/mcp        → wrike-mcp:3000
https://mcp.example.com/github/    → github-mcp:3000      (path routing)
-- or --
https://wrike.mcp.example.com/     → wrike-mcp:3000       (subdomain routing)
https://github.mcp.example.com/    → github-mcp:3000
```

### 1. Start the shared proxy (once)

```bash
docker network create mcp-proxy
cd /opt/mcp-proxy                        # copy deploy/proxy/* there
mkdir -p certs                         # then put fullchain.pem + privkey.pem in it
#   (one SAN or wildcard cert covering mcp.example.com and/or *.mcp.example.com)
docker compose up -d
```

### 2. Attach each MCP server

In this project:

```bash
cp docker-compose.override.shared-proxy.yml.example docker-compose.override.yml
docker compose up -d --build
```

The override disables this project's own nginx and attaches the app container
to the shared `mcp-proxy` network. For **every other** MCP server you add,
repeat the same pattern: no bundled proxy, join `mcp-proxy`, publish nothing.

### 3. Add a route in the proxy config

One `location` block (or subdomain `server` block) per server — see
`deploy/proxy/default.conf` for a commented example.

## Rules that keep this safe and simple

- **Unique `TOKEN_ENCRYPTION_KEY` per project** — independent compromise isolation; a leaked key for one service never exposes another's token store.
- **Unique project names / container names** — they are the DNS names on the shared network (`wrike-mcp`, `github-mcp`, …).
- **Nothing else publishes ports** — only the proxy has `ports:`; every app uses `expose:` on the shared network. No accidental direct exposure.
- **Per-service users** — each MCP server has its own per-user auth; users connect to each service separately (there is no cross-server SSO in the MCP ecosystem today). A user connecting to Wrike MCP and GitHub MCP holds two unrelated connection tokens.
- **Memory budget** — proxy ~128 MB + ~100–200 MB per MCP server; size the droplet accordingly (2 GB ≈ proxy + 4–5 servers comfortably).
- **Renewals** — certbot renewal copies new certs into `/opt/mcp-proxy/certs/` and runs `docker compose restart proxy` (monthly timer) — one cert to renew regardless of how many servers sit behind it.

## Updating one server without touching the others

```bash
cd /opt/wrike-mcp && git pull && docker compose up -d --build
```

Projects are fully independent: a rebuild of one never restarts the others,
and each keeps its own encrypted token volume, so users keep their connections.