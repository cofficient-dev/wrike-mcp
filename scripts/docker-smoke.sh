#!/usr/bin/env bash
# Container smoke test: run the built image in PAT mode and verify endpoints.
set -e
KEY=$(node -e "console.log('ab'.repeat(32))")

docker rm -f wrike-mcp-smoke >/dev/null 2>&1 || true
docker run -d --name wrike-mcp-smoke -p 3481:3000 \
  -e TOKEN_ENCRYPTION_KEY="$KEY" \
  -e WRIKE_PAT=container-pat-token \
  wrike-mcp:test >/dev/null

for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3481/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "--- healthz ---"
curl -s http://127.0.0.1:3481/healthz; echo

echo "--- runs as non-root ---"
docker exec wrike-mcp-smoke id

echo "--- token store volume perms ---"
MSYS_NO_PATHCONV=1 docker exec wrike-mcp-smoke ls -la /var/lib/wrike-mcp

echo "--- MCP initialize (pat mode, no bearer needed) ---"
curl -s -X POST http://127.0.0.1:3481/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"0"}}}' | head -c 250; echo

echo "--- PAT never leaks ---"
LEAKS=$(curl -s http://127.0.0.1:3481/healthz; curl -s -X POST http://127.0.0.1:3481/mcp -d '{}' 2>/dev/null)
if echo "$LEAKS" | grep -q 'container-pat-token'; then echo "LEAK DETECTED"; exit 1; else echo "no leak"; fi

docker rm -f wrike-mcp-smoke >/dev/null
echo "CONTAINER SMOKE COMPLETE"