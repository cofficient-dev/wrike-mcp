import { describe, it, expect, vi } from 'vitest';
import { createHttpApp } from '../src/httpServer.js';
import { redact } from '../src/redact.js';
import { AuthManager } from '../src/auth/authManager.js';
import { AttachmentLinks } from '../src/auth/attachmentLinks.js';
import { EncryptedTokenStore } from '../src/secrets/tokenStore.js';
import type { AppConfig } from '../src/config.js';
import { SessionManager } from '../src/transport.js';
import { createMcpServer } from '../src/server.js';
import { createToolRegistry } from '../src/tools/toolRegistry.js';
import { buildTools } from '../src/tools/toolDefinitions.js';
import { WrikeClient } from '../src/wrikeClient.js';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const key = randomBytes(32);

function makeApp(config: AppConfig, opts: { fetchImpl?: typeof fetch; links?: AttachmentLinks } = {}) {
  const store = new EncryptedTokenStore(config.tokenEncryptionKey, config.tokenStorePath);
  const authManager = new AuthManager(config.auth, store);
  const registry = createToolRegistry(buildTools());
  const sessionManager = new SessionManager((userId) =>
    createMcpServer(registry, new WrikeClient(authManager, userId))
  );
  const app = createHttpApp({
    config,
    authManager,
    sessionManager,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.links ? { links: opts.links } : {}),
  });
  return { app, authManager };
}

function oauthConfig(): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    auth: {
      mode: 'oauth',
      clientId: 'cid',
      clientSecret: 'SECRET-CLIENT-SECRET',
      redirectUri: 'https://example.com/oauth/callback',
      scopes: ['Default'],
    },
    tokenEncryptionKey: key,
    tokenStorePath: join(tmpdir(), `http-${randomBytes(4).toString('hex')}`, 'tokens.json'),
  };
}

function patConfig(): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    auth: { mode: 'pat', pat: 'SECRET-PAT-TOKEN', host: 'www.wrike.com' },
    tokenEncryptionKey: key,
    tokenStorePath: join(tmpdir(), `http-${randomBytes(4).toString('hex')}`, 'tokens.json'),
  };
}

describe('healthz', () => {
  it('returns ok', async () => {
    const { app } = makeApp(patConfig());
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('mcp endpoint auth', () => {
  it('returns 401 with WWW-Authenticate when no connection token is supplied', async () => {
    const { app } = makeApp(oauthConfig());
    const res = await request(app).post('/mcp');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.body.error).toBe('not_authorized');
  });

  it('returns 401 for a forged connection token', async () => {
    const { app } = makeApp(oauthConfig());
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer wmc_forged');
    expect(res.status).toBe(401);
  });

  it('serves MCP once a valid connection token is used', async () => {
    const { app, authManager } = makeApp(oauthConfig());
    await authManager.storeUserTokens('alice', {
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAtMs: Date.now() + 3600_000,
      host: 'www.wrike.com',
    });
    const ct = await authManager.issueConnectionToken('alice');
    // initialize request establishes the session
    const init = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${ct}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(init.status).toBe(200);
    expect(init.text).toContain('wrike-mcp');
    expect(init.text).not.toContain(ct);
    const sessionId = init.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();

    const tools = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${ct}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(tools.status).toBe(200);
    expect(tools.text).toContain('create_task');
  });

  it('serves in pat mode without a Bearer header (single user)', async () => {
    const { app } = makeApp(patConfig());
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(res.status).toBe(200);
    expect(res.text).toContain('wrike-mcp');
  });
});

describe('connect flow (per-user)', () => {
  it('GET /connect redirects to Wrike with a state bound to the handle', async () => {
    const { app } = makeApp(oauthConfig());
    const res = await request(app).get('/connect?user=alice');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://login.wrike.com/oauth2/authorize/v4');
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.search).not.toContain('SECRET-CLIENT-SECRET');
  });

  it('sanitizes hostile handles', async () => {
    const { app } = makeApp(oauthConfig());
    const res = await request(app).get('/connect?user=<script>alert(1)</script>');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.searchParams.get('state')).toBeTruthy();
  });

  it('GET /oauth/callback rejects a bad state', async () => {
    const { app } = makeApp(oauthConfig());
    const res = await request(app).get('/oauth/callback?code=x&state=forged');
    expect(res.status).toBe(400);
  });

  it('completes the flow: stores per-user tokens and shows the one-time connection token', async () => {
    const config = oauthConfig();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'SECRET-NEW-ACCESS',
          refresh_token: 'SECRET-NEW-REFRESH',
          token_type: 'bearer',
          expires_in: 3600,
          host: 'app-eu.wrike.com',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch });

    // Get a genuine state from /connect.
    const connectRes = await request(app).get('/connect?user=alice');
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;

    const res = await request(app).get(`/oauth/callback?code=the-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('wmc_');
    expect(res.text).toContain('alice');
    // Wrike access/refresh tokens never leak into the page.
    expect(res.text).not.toContain('SECRET-NEW-ACCESS');
    expect(res.text).not.toContain('SECRET-NEW-REFRESH');
    // Token exchange happened server-to-server.
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://login.wrike.com/oauth2/token');
    expect(init.body as URLSearchParams).toBeTruthy();
  });

  it('reports denied authorization clearly', async () => {
    const { app } = makeApp(oauthConfig());
    const res = await request(app).get('/oauth/callback?error=access_denied');
    expect(res.status).toBe(400);
    expect(res.text).toContain('denied');
  });
});

describe('revoke (self-service)', () => {
  it('removes the calling user with a valid connection token', async () => {
    const { app, authManager } = makeApp(oauthConfig());
    await authManager.storeUserTokens('alice', {
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAtMs: Date.now() + 3600_000,
      host: 'www.wrike.com',
    });
    const ct = await authManager.issueConnectionToken('alice');
    const res = await request(app).post('/revoke').set('Authorization', `Bearer ${ct}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'revoked' });
    // Their connection token no longer works.
    const mcp = await request(app).post('/mcp').set('Authorization', `Bearer ${ct}`);
    expect(mcp.status).toBe(401);
  });

  it('requires authentication to revoke', async () => {
    const { app } = makeApp(oauthConfig());
    const res = await request(app).post('/revoke');
    expect(res.status).toBe(401);
  });
});

describe('oauth endpoints absent in pat mode', () => {
  it('returns 404 for /connect and /oauth/authorize', async () => {
    const { app } = makeApp(patConfig());
    expect((await request(app).get('/connect')).status).toBe(404);
    expect((await request(app).get('/oauth/authorize')).status).toBe(404);
  });
});

describe('secret hygiene', () => {
  it('no response ever contains the PAT or client secret', async () => {
    const { app } = makeApp(patConfig());
    for (const res of [
      await request(app).get('/healthz'),
      await request(app).get('/no-such-endpoint'),
      await request(app).post('/mcp').send({}),
    ]) {
      expect(res.text).not.toContain('SECRET-PAT-TOKEN');
    }
  });

  it('redact() strips bearer tokens, token values, and connection tokens', () => {
    expect(redact('Authorization: bearer abc123xyz')).toBe('Authorization: [REDACTED]');
    expect(redact('access_token=abc123')).toBe('[REDACTED]');
    expect(redact('your token wmc_ABC123xyz is invalid')).toBe('your token [REDACTED] is invalid');
  });

  it('redact() leaves ordinary text untouched', () => {
    expect(redact('Wrike API error 404 (not_found): task not found')).toContain('task not found');
  });
});

describe('GET /attachments/:id/file (signed download)', () => {
  function configWithPublicBaseUrl(): AppConfig {
    return { ...patConfig(), publicBaseUrl: 'https://mcp.example.com/wrike' };
  }

  function binaryFetch(body: string, headers: Record<string, string> = {}) {
    return vi.fn().mockResolvedValue(
      new Response(new Uint8Array(Buffer.from(body)), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="shot.png"', ...headers },
      })
    );
  }

  it('streams bytes with the right Content-Type and Content-Disposition for a valid token', async () => {
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const fetchImpl = binaryFetch('PNGBYTES');
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'IEAGIITRIMFWG6YH')).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/IEAGIITRIMFWG6YH/file?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['content-disposition']).toContain('filename="shot.png"');
    expect(Buffer.from(res.body as Uint8Array).toString()).toBe('PNGBYTES');
  });

  it('marks the response private and uncacheable', async () => {
    // Private file bytes authorised by a URL-borne credential: a shared or
    // intermediary cache must not be left to its own heuristics about them.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const fetchImpl = binaryFetch('PNGBYTES');
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'IEAGIITRIMFWG6YH')).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/IEAGIITRIMFWG6YH/file?token=${encodeURIComponent(token)}`);

    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('streams rather than buffering the whole body', async () => {
    // The route has no byte cap by design, so it must not hold the file in
    // memory: a few concurrent large downloads would otherwise exhaust the
    // process, and the rate limiter counts requests, not bytes. Asserting
    // the body is consumed incrementally is the observable proxy for that.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const chunk = 'y'.repeat(64 * 1024);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 8) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(Buffer.from(chunk)));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
    );
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'STREAMEDATTACH01')).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/STREAMEDATTACH01/file?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(200);
    // All 8 chunks arrive intact through the pipe.
    expect((res.body as Uint8Array).length).toBe(chunk.length * 8);
  });

  it('does not apply the MCP inline-download byte cap', async () => {
    // MAX_INLINE_DOWNLOAD_BYTES exists only because base64 rides inside an
    // MCP tool response; a direct browser download must not be capped by it.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const big = 'x'.repeat(6 * 1024 * 1024); // over the 5MB MCP inline cap
    const fetchImpl = binaryFetch(big);
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'BIGATTACHMENTID1')).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/BIGATTACHMENTID1/file?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect((res.body as Uint8Array).length).toBe(big.length);
  });

  it('rejects an expired token', async () => {
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!, -1);
    const { app } = makeApp(config, { links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'IEAGIITRIMFWG6YH')).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/IEAGIITRIMFWG6YH/file?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(403);
  });

  it('rejects a tampered token', async () => {
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const { app } = makeApp(config, { links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'IEAGIITRIMFWG6YH')).searchParams.get('token')!;
    const res = await request(app).get(
      `/attachments/IEAGIITRIMFWG6YH/file?token=${encodeURIComponent(token)}x`
    );
    expect(res.status).toBe(403);
  });

  it('rejects a token issued for a different attachment', async () => {
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const { app } = makeApp(config, { links });

    // Token minted for attachment A, presented against attachment B's path.
    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'ATTACHMENTAAAAAA')).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/ATTACHMENTBBBBBB/file?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(403);
  });

  it('404s when no signer is configured (PUBLIC_BASE_URL unset)', async () => {
    const { app } = makeApp(patConfig());
    const res = await request(app).get('/attachments/IEAGIITRIMFWG6YH/file?token=whatever');
    expect(res.status).toBe(404);
  });

  it('404s when no token is supplied at all', async () => {
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const { app } = makeApp(config, { links });
    const res = await request(app).get('/attachments/IEAGIITRIMFWG6YH/file');
    expect(res.status).toBe(404);
  });
});