// E2E smoke test: per-user flow against a running server.
// Run: node scripts/e2e-peruser.cjs   (after npm run build)
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const PORT = 3471;
const KEY = crypto.randomBytes(32).toString('hex');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function main() {
  const server = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      TOKEN_ENCRYPTION_KEY: KEY,
      WRIKE_CLIENT_ID: 'cid',
      WRIKE_CLIENT_SECRET: 'csec',
      WRIKE_REDIRECT_URI: 'https://example.com/cb',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  await wait(1500);

  try {
    const base = `http://127.0.0.1:${PORT}`;

    // 1. Start connect flow, capture state.
    const connect = await fetchJson(`${base}/connect?user=alice`, { redirect: 'manual' });
    const loc = new URL(connect.headers.get('location'));
    const state = loc.searchParams.get('state');
    console.log('1. /connect -> 302 with state bound to alice:', state !== null);

    // 2. Callback rejects forged states.
    const forged = await fetchJson(`${base}/oauth/callback?code=x&state=forged`);
    console.log('2. forged state ->', forged.status, '(expect 400)');

    // 3. healthz
    const healthz = await fetchJson(`${base}/healthz`);
    console.log('3. /healthz ->', healthz.status, healthz.text);

    // 4. MCP without a token
    const unauth = await fetchJson(`${base}/mcp`, { method: 'POST' });
    console.log('4. /mcp unauthenticated ->', unauth.status, '(expect 401)');

    // 5. Simulate completed OAuth for alice: store her tokens directly in the
    //    encrypted store (same API the callback uses) and issue a connection token.
    const { EncryptedTokenStore } = require('../dist/secrets/tokenStore.js');
    const { AuthManager } = require('../dist/auth/authManager.js');
    const store = new EncryptedTokenStore(Buffer.from(KEY, 'hex'), 'data/tokens.json');
    const mgr = new AuthManager(
      { mode: 'oauth', clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://example.com/cb', scopes: ['Default'] },
      store
    );
    await mgr.storeUserTokens('alice', {
      accessToken: 'E2E-ACCESS',
      refreshToken: 'E2E-REFRESH',
      expiresAtMs: Date.now() + 3600_000,
      host: 'app-eu.wrike.com',
    });
    const ct = await mgr.issueConnectionToken('alice');
    console.log('5. user alice stored, connection token issued (starts with wmc_):', ct.startsWith('wmc_'));

    // 6. MCP initialize with the connection token
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ct}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
      }),
    });
    const initText = await init.text();
    const sessionId = init.headers.get('mcp-session-id');
    console.log('6. initialize ->', init.status, '| session header:', Boolean(sessionId), '| body mentions wrike-mcp:', initText.includes('wrike-mcp'));
    console.log('   connection token leaked in response:', initText.includes(ct));

    // 7. tools/list on the established session
    const tools = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ct}`,
        'mcp-session-id': sessionId,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const toolsText = await tools.text();
    console.log('7. tools/list ->', tools.status, '| tools found:', (toolsText.match(/"name":"/g) || []).length);

    // 8. Revoke and confirm the token stops working.
    const revoke = await fetch(`${base}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${ct}` } });
    const revokeText = await revoke.text();
    console.log('8. /revoke ->', revoke.status, revokeText);
    const afterRevoke = await fetchJson(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${ct}` } });
    console.log('   token after revoke ->', afterRevoke.status, '(expect 401)');

    console.log('E2E COMPLETE');
    await wait(300);
  } finally {
    server.kill();
    await wait(200);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});