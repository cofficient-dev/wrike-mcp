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

The shared proxy routes by path or subdomain to each server on the common
`mcp-proxy` Docker network:

```
https://mcp.example.com/mcp        → wrike-mcp:3000
https://mcp.example.com/github/    → github-mcp:3000      (path routing)
-- or --
https://wrike.mcp.example.com/     → wrike-mcp:3000       (subdomain routing)
https://github.mcp.example.com/    → github-mcp:3000
```

## First-time install

On a fresh droplet, clone the repo first — every server in `/opt/` is a
git clone:

```bash
git clone <your-repo> /opt/wrike-mcp
```

Then continue below: start the proxy, attach this project, add its route.


## Option A: Caddy proxy (automatic TLS — recommended)

No certificate to buy, copy, or renew. Point DNS at the droplet, then paste
this once — it creates `/opt/mcp-proxy` with everything and starts Caddy:

```bash
mkdir -p /opt/mcp-proxy && cd /opt/mcp-proxy
docker network create mcp-proxy

cat > docker-compose.yml <<'EOF'
services:
  caddy:
    image: caddy:2.8-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    networks: [mcp-proxy]
    deploy:
      resources:
        limits: { memory: 128M }

networks:
  mcp-proxy:
    external: true

volumes:
  caddy-data:
EOF

cat > Caddyfile <<'EOF'
{
    email admin@example.com
}
mcp.example.com {
    # RFC 8414/9728 discovery: the well-known segment comes BEFORE the issuer
    # path, so these URLs are host-rooted and never match handle_path /wrike/*.
    # Without them, spec-compliant MCP clients fail discovery. Keep them first.
    handle /.well-known/oauth-authorization-server/wrike* {
        reverse_proxy wrike-mcp:3000
    }
    handle /.well-known/oauth-protected-resource/wrike* {
        reverse_proxy wrike-mcp:3000
    }

    # path routing: each MCP server gets a path prefix
    handle_path /wrike/* {
        reverse_proxy wrike-mcp:3000
    }
    # handle /.well-known/oauth-authorization-server/github* {
    #     reverse_proxy github-mcp:3000
    # }
    # handle /.well-known/oauth-protected-resource/github* {
    #     reverse_proxy github-mcp:3000
    # }
    # handle_path /github/* {
    #     reverse_proxy github-mcp:3000
    # }
}
EOF

# Replace mcp.example.com and admin@example.com with your own:
nano Caddyfile

docker compose up -d
```

That's it — the certificate is obtained and renewed automatically. The
`caddy-data` volume stores the certs, so keep it across rebuilds.


Users connect at `https://mcp.example.com/wrike/connect` and configure the
MCP client URL `https://mcp.example.com/wrike/mcp`. In `.env`, set
`WRIKE_REDIRECT_URI=https://mcp.example.com/wrike/oauth/callback` (and
register exactly that URI in the Wrike App Console).

Also set `PUBLIC_BASE_URL=https://mcp.example.com/wrike` — including the path
prefix. The `/.well-known/*` and `/oauth/*` endpoints are mounted only when it
is set, so without it native sign-in does not exist and clients get 404s from
discovery with no other symptom.

The Caddyfile above already carries the two host-rooted `/.well-known/` handles
this needs. They are not optional for a path-prefixed issuer: RFC 8414 §3.1 and
RFC 9728 §3.1 put the well-known segment *before* the issuer path, so a
spec-compliant client fetches
`https://mcp.example.com/.well-known/oauth-authorization-server/wrike`, which
never matches `handle_path /wrike/*`. Drop those blocks and only the
non-standard prefixed location is served, so strict clients fail discovery.

Subdomain deployments (`https://wrike.example.com`) have an empty issuer path
and need none of this.

Then attach each MCP server (step below). Another server on the same host =
another path block in the Caddyfile:

```caddyfile
handle_path /github/* {
    reverse_proxy github-mcp:3000
}
```

Wildcards (`*.mcp.example.com`) need the DNS-01 challenge — see notes in
`deploy/caddy/docker-compose.yml`.

## Option B: nginx proxy (you already have a certificate)

1. Copy `deploy/proxy/*` to `/opt/mcp-proxy/`, then put `fullchain.pem` +
   `privkey.pem` into `/opt/mcp-proxy/certs/` (one SAN or wildcard cert
   covering your hostnames).

```bash
docker network create mcp-proxy
cd /opt/mcp-proxy
docker compose up -d
```

2. Add one route per server in `default.conf` — see the commented examples
   inside it.
3. Monthly renewal timer: certbot renew → copy certs into `certs/` →
   `docker compose restart proxy`.

## Attach each MCP server

In this project:

```bash
cd /opt/wrike-mcp                          # cloned in "First-time install" above
git pull                                   # on updates
cp docker-compose.override.shared-proxy.yml.example docker-compose.override.yml
docker compose up -d --build
```

The override disables this project's own nginx and attaches the app container
to the shared `mcp-proxy` network. For **every other** MCP server you add,
repeat the same pattern: no bundled proxy, join `mcp-proxy`, publish nothing.

## Rules that keep this safe and simple

- **Unique `TOKEN_ENCRYPTION_KEY` per project** — independent compromise isolation; a leaked key for one service never exposes another's token store.
- **Unique project names / container names** — they are the DNS names on the shared network (`wrike-mcp`, `github-mcp`, …).
- **Nothing else publishes ports** — only the proxy has `ports:`; every app uses `expose:` on the shared network. No accidental direct exposure.
- **Per-service users** — each MCP server has its own per-user auth; users connect to each service separately (there is no cross-server SSO in the MCP ecosystem today). A user connecting to Wrike MCP and GitHub MCP holds two unrelated connection tokens.
- **Memory budget** — proxy ~128 MB + ~100–200 MB per MCP server; size the droplet accordingly (2 GB ≈ proxy + 4–5 servers comfortably).
- **Renewals** — Caddy renews automatically; the nginx variant needs the certbot copy + restart timer from its section.

## Updating one server without touching the others

```bash
cd /opt/wrike-mcp && git pull && docker compose up -d --build
```

Projects are fully independent: a rebuild of one never restarts the others,
and each keeps its own encrypted token volume, so users keep their connections.