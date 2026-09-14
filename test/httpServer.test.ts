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

describe('mcp session recovery after a restart (unknown mcp-session-id)', () => {
  // A restart discards the in-memory session map. The client's next request
  // still carries its old mcp-session-id, and the server must answer with
  // HTTP 404 so the client's spec-mandated recovery (reinitialize) actually
  // fires, rather than silently starting a new, uninitialized session.

  it('returns 404 with a JSON-RPC error body for an unknown mcp-session-id, and does not create a session', async () => {
    const { app } = makeApp(patConfig());
    const res = await request(app)
      .post('/mcp')
      .set('mcp-session-id', 'no-such-session-id')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_task' } });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found or expired. Reinitialize the connection with a new InitializeRequest.',
      },
      id: null,
    });
    // No new session was minted for the unknown id.
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  it('still 404s an initialize request that carries a stale mcp-session-id (not special-cased)', async () => {
    // The spec requires a reinitializing client to send InitializeRequest
    // WITHOUT a session ID attached. A client that (incorrectly) keeps
    // sending its old mcp-session-id header on initialize gets the same 404
    // as any other request with an unknown id: handleRequest does not
    // special-case the initialize method. That is correct per spec, but it
    // means a client with this bug never recovers on its own — every retry
    // still carries the stale header, so every retry 404s again, forever.
    // This test exists so that failure mode is found here, in a test that
    // explains it, rather than rediscovered from a support ticket about a
    // client stuck in a 404 loop.
    const { app } = makeApp(patConfig());
    const res = await request(app)
      .post('/mcp')
      .set('mcp-session-id', 'no-such-session-id')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });

    expect(res.status).toBe(404);
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  it('still creates a session and returns mcp-session-id when no header is sent at all (unchanged)', async () => {
    const { app } = makeApp(patConfig());
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeTruthy();
  });

  it('still routes to the existing session for a known mcp-session-id (unchanged)', async () => {
    const { app } = makeApp(patConfig());
    const init = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const sessionId = init.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();

    const tools = await request(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(tools.status).toBe(200);
    expect(tools.text).toContain('create_task');
    // The existing session is reused, not replaced.
    expect(tools.headers['mcp-session-id']).toBe(sessionId);
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

  it('escapes a backslash in the filename so the quoted-string stays terminated', async () => {
    // 0x5C is printable, so it survives the ASCII strip. Unescaped, a name
    // ending in one emits filename="report\" — the trailing \" escapes the
    // closing quote and a lenient parser swallows the filename* after it.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const fetchImpl = binaryFetch('BYTES', {
      'Content-Disposition': 'attachment; filename="report\\\\"',
    });
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'BACKSLASHNAME001')).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/BACKSLASHNAME001/file?token=${encodeURIComponent(token)}`);

    const cd = res.headers['content-disposition'] as string;
    expect(cd).toContain('filename="report\\\\"');
    // The quoted-string must close before filename*, not swallow it.
    expect(cd).toMatch(/filename="report\\\\";\s*filename\*=/);
  });

  it('cancels the upstream Wrike stream when the client aborts', async () => {
    // pipe() alone would unpipe on client close and leave the Wrike response
    // unconsumed, stranding that connection — costly on an uncapped route
    // whose transfers are long by design.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('z'.repeat(16 * 1024))));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
    );
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const token = new URL(links.issue(AuthManager.PAT_USER_ID, 'ABORTEDDOWNLOAD1')).searchParams.get('token')!;
    const req = request(app)
      .get(`/attachments/ABORTEDDOWNLOAD1/file?token=${encodeURIComponent(token)}`)
      .buffer(false);
    // Abort once bytes are flowing, mimicking a browser that goes away.
    // Aborting mid-response makes the client socket raise ECONNRESET, which
    // is the expected outcome here but reaches vitest as an unhandled error
    // ("this might cause false positive tests") unless something listens for
    // it. Collect rather than discard: swallowing every error would also hide
    // a connection refused, a server that never responds, or an unexpected
    // early end, any of which would let this test pass vacuously.
    const clientErrors: NodeJS.ErrnoException[] = [];
    req.on('error', (err: NodeJS.ErrnoException) => clientErrors.push(err));
    req.on('response', (res) => {
      res.on('error', (err: NodeJS.ErrnoException) => clientErrors.push(err));
      setImmediate(() => req.abort());
    });
    await new Promise<void>((resolve) => {
      req.end(() => resolve());
    });
    await new Promise((r) => setTimeout(r, 50));

    // Assert something was actually caught before asserting what it was:
    // comparing a derived list against itself passes trivially on an empty
    // array, so without this guard the check below would silently prove
    // nothing on any run where the abort lands after the response completes.
    expect(clientErrors.length).toBeGreaterThan(0);
    // The deliberate abort is the only failure this test tolerates.
    expect([...new Set(clientErrors.map((e) => e.code))]).toEqual(['ECONNRESET']);
    expect(cancelled).toBe(true);
  });

  it('refuses an attachment id that does not match the expected shape', async () => {
    // Defense in depth: the id is interpolated into a Wrike API path on an
    // unauthenticated route. A correctly signed token is used here — issue()
    // itself does not validate shape — so this proves the route's own check
    // fires rather than the HMAC merely failing.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const fetchImpl = binaryFetch('BYTES');
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const oddId = '../../../account';
    const token = new URL(links.issue(AuthManager.PAT_USER_ID, oddId)).searchParams.get('token')!;
    const res = await request(app)
      .get(`/attachments/${encodeURIComponent(oddId)}/file?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(404);
    // Nothing was fetched from Wrike.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an attachment id longer than the 128-char WrikeIdSchema ceiling', async () => {
    // This route used to validate the id against a hand-copied regex that
    // silently drifted out of step with WrikeIdSchema twice. It now imports
    // the schema directly, so the ceiling cannot drift again — but keep the
    // boundary covered here, since the route is unauthenticated and the id
    // reaches an upstream Wrike path.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const fetchImpl = binaryFetch('BYTES');
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const tooLongId = 'A'.repeat(129);
    const token = new URL(links.issue(AuthManager.PAT_USER_ID, tooLongId)).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/${tooLongId}/file?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts an attachment id at the 128-char WrikeIdSchema ceiling', async () => {
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const fetchImpl = binaryFetch('BYTES');
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const maxLengthId = 'A'.repeat(128);
    const token = new URL(links.issue(AuthManager.PAT_USER_ID, maxLengthId)).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/${maxLengthId}/file?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('accepts a new-format mixed-case attachment id (previously 404ed under the old uppercase-only shape check)', async () => {
    // Live sweep regression: this account mints 12-char mixed-case
    // attachment ids (e.g. MQAAAAEPpWtv) alongside legacy uppercase ones.
    // The route's own ATTACHMENT_ID check used to be ^[A-Z0-9]{16}$, so any
    // recently-uploaded attachment would 404 here even with a validly
    // signed token.
    const config = configWithPublicBaseUrl();
    const links = new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl!);
    const fetchImpl = binaryFetch('BYTES');
    const { app } = makeApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, links });

    const newFormatId = 'MQAAAAEPpWtv';
    const token = new URL(links.issue(AuthManager.PAT_USER_ID, newFormatId)).searchParams.get('token')!;
    const res = await request(app).get(`/attachments/${newFormatId}/file?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();
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