#!/usr/bin/env bash
# Shared-proxy smoke test: one nginx proxy container + the wrike-mcp app with
# the shared-proxy override attached to the mcp-proxy network.
set -e
cd "$(dirname "$0")/.."

KEY=$(node -e "console.log('ab'.repeat(32))")

# Secrets/certs for the local test only.
node -e "require('fs').writeFileSync('.env', 'WRIKE_PAT=shared-proxy-test-pat\nWRIKE_HOST=www.wrike.com\nTOKEN_ENCRYPTION_KEY=' + 'ab'.repeat(32) + '\n')"
mkdir -p deploy/proxy/certs
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 \
  -keyout deploy/proxy/certs/privkey.pem -out deploy/proxy/certs/fullchain.pem \
  -days 30 -nodes -subj '/CN=localhost' 2>/dev/null

# 1. shared network + proxy
docker network create mcp-proxy >/dev/null 2>&1 || true
docker compose -f deploy/proxy/docker-compose.yml up -d >/dev/null

# 2. this project with the shared-proxy override
cp docker-compose.override.shared-proxy.yml.example docker-compose.override.yml
docker compose up -d --build >/dev/null

# 3. wait for health
for i in $(seq 1 30); do
  if curl -fsSk https://localhost/mcp -X POST -o /dev/null 2>/dev/null; then break; fi
  if curl -fsSk https://localhost/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "--- app containers (bundled nginx must be absent) ---"
docker compose ps -a --format '{{.Name}} {{.State}}'

echo "--- healthz via shared proxy ---"
curl -sk https://localhost/healthz; echo

echo "--- MCP initialize via shared proxy ---"
curl -sk -X POST https://localhost/mcp \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"proxy-smoke","version":"0"}}}' | head -c 200; echo

echo "--- http->https redirect ---"
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' http://localhost/healthz; echo

echo "--- leak check ---"
if curl -sk https://localhost/healthz | grep -q shared-proxy-test-pat; then echo LEAK; else echo no-leak; fi

echo "--- app reachable ONLY via proxy network (host port not published) ---"
if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then echo "UNEXPECTED direct access"; else echo "not directly exposed"; fi

# cleanup
docker compose down -v >/dev/null 2>&1
docker compose -f deploy/proxy/docker-compose.yml down >/dev/null 2>&1
docker network rm mcp-proxy >/dev/null 2>&1 || true
rm -f docker-compose.override.yml .env deploy/proxy/certs/privkey.pem deploy/proxy/certs/fullchain.pem
rmdir deploy/proxy/certs 2>/dev/null || true
echo "SHARED-PROXY SMOKE COMPLETE"