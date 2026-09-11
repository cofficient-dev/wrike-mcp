#!/usr/bin/env bash
# Shared-proxy smoke test: one Caddy proxy container + the wrike-mcp app with
# the shared-proxy override attached to the mcp-proxy network.
#
# Exercises the path-prefixed layout (https://localhost/wrike/...), which is
# the recommended one, including the host-rooted RFC 8414/9728 discovery
# routes that the prefix block cannot match.
#
# Caddy serves `localhost` from its own internal CA (`tls internal`), so there
# is no ACME round trip and no certificate to generate here.
#
# SAFETY: this script must never touch a real deployment. It runs under its
# own compose project name, so its containers and volumes are namespaced away
# from the production project and `down -v` cannot reach the real token store.
# It keeps its env file inside $TMP and overrides `env_file` to point there,
# so the repository's .env is never written, read, or deleted. It also refuses
# to run outright if this checkout looks like a live deployment.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=wrike-mcp-smoke
TMP=.smoke-proxy

# A real deployment keeps its secrets in .env and its wiring in
# docker-compose.override.yml. Both are gitignored, so their presence means
# this is somebody's live checkout (e.g. /opt/wrike-mcp) rather than a clean
# working copy. Losing TOKEN_ENCRYPTION_KEY would make the encrypted token
# store permanently undecryptable, so bail rather than risk it.
for f in .env docker-compose.override.yml; do
  if [ -e "$f" ]; then
    echo "REFUSING TO RUN: $f exists, so this looks like a live deployment." >&2
    echo "Run this from a clean checkout instead — it is a test harness, not a health check." >&2
    exit 1
  fi
done

cleanup() {
  docker compose -p "$PROJECT" -f docker-compose.yml -f "$TMP/override.yml" down -v >/dev/null 2>&1 || true
  docker compose -p "$PROJECT-proxy" -f "$TMP/proxy.yml" down -v >/dev/null 2>&1 || true
  docker network rm mcp-proxy >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP"

# Test secrets live here, never in the repository root.
printf 'WRIKE_PAT=shared-proxy-test-pat\nWRIKE_HOST=www.wrike.com\nTOKEN_ENCRYPTION_KEY=%s\n' \
  "$(node -e "process.stdout.write('ab'.repeat(32))")" > "$TMP/.env"

# Overrides the base env_file so the app reads $TMP/.env, not ./.env.
cat > "$TMP/override.yml" <<EOF
services:
  wrike-mcp:
    env_file:
      - $TMP/.env
    environment:
      HOST: 0.0.0.0
      PORT: 3000
      TOKEN_STORE_PATH: /var/lib/wrike-mcp/tokens.json
    expose:
      - "3000"
    networks:
      - default
      - mcp-proxy
  caddy:
    profiles:
      - disabled
networks:
  mcp-proxy:
    external: true
EOF

cat > "$TMP/Caddyfile" <<'EOF'
localhost {
	tls internal
	handle /.well-known/oauth-authorization-server/wrike* {
		reverse_proxy wrike-mcp:3000
	}
	handle /.well-known/oauth-protected-resource/wrike* {
		reverse_proxy wrike-mcp:3000
	}
	handle_path /wrike/* {
		reverse_proxy wrike-mcp:3000
	}
}
EOF

cat > "$TMP/proxy.yml" <<'EOF'
services:
  caddy:
    image: caddy:2.8-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    networks: [mcp-proxy]
networks:
  mcp-proxy:
    external: true
EOF

# 1. shared network + proxy
docker network create mcp-proxy >/dev/null 2>&1 || true
docker compose -p "$PROJECT-proxy" -f "$TMP/proxy.yml" up -d >/dev/null

# 2. this project with the shared-proxy override
docker compose -p "$PROJECT" -f docker-compose.yml -f "$TMP/override.yml" up -d --build >/dev/null

# 3. wait for health through the proxy
for _ in $(seq 1 30); do
  if curl -fsSk https://localhost/wrike/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "--- app containers (bundled caddy must be absent) ---"
docker compose -p "$PROJECT" -f docker-compose.yml -f "$TMP/override.yml" ps -a --format '{{.Name}} {{.State}}'

echo "--- healthz via shared proxy ---"
curl -sk https://localhost/wrike/healthz; echo

echo "--- MCP initialize via shared proxy ---"
curl -sk -X POST https://localhost/wrike/mcp \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"proxy-smoke","version":"0"}}}' | head -c 200; echo

echo "--- host-rooted discovery route reaches the app (not a proxy 404) ---"
# PAT mode has no MCP OAuth, so the app answers {"error":"not_found"}. Seeing
# that body proves the host-rooted route was proxied rather than dropped by
# Caddy, which is the part handle_path /wrike/* cannot cover.
curl -sk https://localhost/.well-known/oauth-authorization-server/wrike | head -c 80; echo

echo "--- http->https redirect ---"
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' http://localhost/wrike/healthz; echo

echo "--- leak check ---"
if curl -sk https://localhost/wrike/healthz | grep -q shared-proxy-test-pat; then echo LEAK; else echo no-leak; fi

echo "--- app reachable ONLY via proxy network (host port not published) ---"
if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then echo "UNEXPECTED direct access"; else echo "not directly exposed"; fi

echo "SHARED-PROXY SMOKE COMPLETE"
