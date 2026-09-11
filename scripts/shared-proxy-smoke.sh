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
set -e
cd "$(dirname "$0")/.."

TMP=.smoke-proxy
trap 'docker compose down -v >/dev/null 2>&1 || true
      docker compose -f "$TMP/docker-compose.yml" down -v >/dev/null 2>&1 || true
      docker network rm mcp-proxy >/dev/null 2>&1 || true
      rm -rf "$TMP" docker-compose.override.yml .env' EXIT

# Secrets for the local test only.
node -e "require('fs').writeFileSync('.env', 'WRIKE_PAT=shared-proxy-test-pat\nWRIKE_HOST=www.wrike.com\nTOKEN_ENCRYPTION_KEY=' + 'ab'.repeat(32) + '\n')"

mkdir -p "$TMP"
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
cat > "$TMP/docker-compose.yml" <<'EOF'
services:
  caddy:
    image: caddy:2.8-alpine
    container_name: mcp-proxy-caddy
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
docker compose -f "$TMP/docker-compose.yml" up -d >/dev/null

# 2. this project with the shared-proxy override
cp docker-compose.override.shared-proxy.yml.example docker-compose.override.yml
docker compose up -d --build >/dev/null

# 3. wait for health through the proxy
for _ in $(seq 1 30); do
  if curl -fsSk https://localhost/wrike/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "--- app containers (bundled caddy must be absent) ---"
docker compose ps -a --format '{{.Name}} {{.State}}'

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
