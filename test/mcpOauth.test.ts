import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../src/httpServer.js';
import { AuthManager } from '../src/auth/authManager.js';
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
import { randomBytes, createHash } from 'node:crypto';

const key = randomBytes(32);

function oauthConfig(publicBaseUrl?: string): AppConfig {
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
        tokenStorePath: join(tmpdir(), `mcpoauth-${randomBytes(4).toString('hex')}`, 'tokens.json'),
        ...(publicBaseUrl ? { publicBaseUrl } : {}),
    };
}

function makeApp(config: AppConfig, wrikeTokens?: { access_token: string; refresh_token: string; expires_in: number }) {
    const store = new EncryptedTokenStore(config.tokenEncryptionKey, config.tokenStorePath);
    const authManager = new AuthManager(config.auth, store);
    const registry = createToolRegistry(buildTools());
    const sessionManager = new SessionManager((userId) =>
        createMcpServer(registry, new WrikeClient(authManager, userId))
    );
    const fetchImpl = (async (url: string) => {
        if (url.includes('login.wrike.com')) {
            return new Response(
                JSON.stringify({
                    access_token: wrikeTokens?.access_token ?? 'WRIKE-AT',
                    refresh_token: wrikeTokens?.refresh_token ?? 'WRIKE-RT',
                    token_type: 'access_token',
                    expires_in: wrikeTokens?.expires_in ?? 3600,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const app = createHttpApp({ config, authManager, sessionManager, fetchImpl });
    return { app, authManager, storePath: config.tokenStorePath };
}

/**
 * Walks the MCP consent screen: GET /connect renders it, the user submits,
 * and /connect/confirm redirects on to Wrike. Returns the Wrike redirect.
 */
async function consent(
    app: ReturnType<typeof makeApp>['app'],
    connectUrl: URL,
    overrides: { user?: string } = {}
) {
    const shown = await request(app).get('/connect').query({
        user: connectUrl.searchParams.get('user')!,
        resume: connectUrl.searchParams.get('resume')!,
    });
    expect(shown.status).toBe(200);
    const nonce = /name="nonce" value="([^"]+)"/.exec(shown.text)![1]!;
    const cookie = (shown.headers['set-cookie'] as unknown as string[])[0]!;
    return request(app)
        .post('/connect/confirm')
        .set('Cookie', cookie)
        .type('form')
        .send({
            resume: connectUrl.searchParams.get('resume')!,
            user: overrides.user ?? connectUrl.searchParams.get('user')!,
            nonce,
        });
}

function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

describe('MCP OAuth discovery', () => {
    it('serves protected-resource metadata when PUBLIC_BASE_URL is set', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com/wrike'));
        const res = await request(app).get('/.well-known/oauth-protected-resource');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            resource: 'https://mcp.example.com/wrike',
            authorization_servers: ['https://mcp.example.com/wrike'],
        });
    });

    it('serves authorization-server metadata', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com/wrike'));
        const res = await request(app).get('/.well-known/oauth-authorization-server');
        expect(res.status).toBe(200);
        expect(res.body.issuer).toBe('https://mcp.example.com/wrike');
        expect(res.body.authorization_endpoint).toBe('https://mcp.example.com/wrike/oauth/authorize');
        expect(res.body.token_endpoint).toBe('https://mcp.example.com/wrike/oauth/token');
        expect(res.body.grant_types_supported).toEqual(['authorization_code']);
        expect(res.body.code_challenge_methods_supported).toContain('S256');
    });

    it('serves metadata at the RFC 8414/9728 issuer-suffixed paths', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com/wrike'));
        // RFC 8414 3.1 puts the well-known segment before the issuer path, so a
        // compliant client asks for /.well-known/oauth-authorization-server/wrike.
        const as = await request(app).get('/.well-known/oauth-authorization-server/wrike');
        expect(as.status).toBe(200);
        expect(as.body.issuer).toBe('https://mcp.example.com/wrike');
        const pr = await request(app).get('/.well-known/oauth-protected-resource/wrike');
        expect(pr.status).toBe(200);
        expect(pr.body.resource).toBe('https://mcp.example.com/wrike');
    });

    it('404s the metadata without PUBLIC_BASE_URL', async () => {
        const { app } = makeApp(oauthConfig());
        const res = await request(app).get('/.well-known/oauth-protected-resource');
        expect(res.status).toBe(404);
    });
});

describe('MCP OAuth authorization-code flow', () => {
    it('runs DCR -> authorize -> Wrike consent -> token exchange end-to-end', async () => {
        const { app, authManager } = makeApp(oauthConfig('https://mcp.example.com/wrike'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const { verifier, challenge } = pkce();

        // 1. Dynamic client registration.
        const reg = await request(app)
            .post('/oauth/register')
            .send({ client_name: 'claude', redirect_uris: [clientRedirectUri] });
        expect(reg.status).toBe(201);
        const clientId = reg.body.client_id as string;
        expect(clientId).toMatch(/^mcp_/);

        // 2. Authorize: redirected to the Wrike connect flow with a resume token.
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: clientId,
            redirect_uri: clientRedirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'client-state-123',
        });
        expect(auth.status).toBe(302);
        // Absolute URL with path prefix — a relative redirect would drop it
        // behind handle_path /wrike/* routing.
        const connectUrl = new URL(auth.headers.location!);
        expect(connectUrl.origin).toBe('https://mcp.example.com');
        expect(connectUrl.pathname).toBe('/wrike/connect');
        const resume = connectUrl.searchParams.get('resume')!;

        // 3. Consent screen names the client, then /connect goes on to Wrike.
        const shown = await request(app).get('/connect').query({
            user: connectUrl.searchParams.get('user')!,
            resume,
        });
        expect(shown.status).toBe(200);
        expect(shown.text).toContain('claude');
        expect(shown.text).toContain(clientId);
        const connect = await consent(app, connectUrl);
        expect(connect.status).toBe(302);
        const wrikeUrl = new URL(connect.headers.location!, 'https://login.wrike.com');
        const state = wrikeUrl.searchParams.get('state')!;

        // 4. Wrike calls back: user is redirected to the CLIENT with a code.
        const cb = await request(app).get('/oauth/callback').query({ code: 'wrike-code-1', state });
        expect(cb.status).toBe(302);
        const back = new URL(cb.headers.location!);
        expect(back.origin + back.pathname).toBe(clientRedirectUri);
        const code = back.searchParams.get('code')!;
        expect(back.searchParams.get('state')).toBe('client-state-123');

        // 5. Token exchange (correct PKCE verifier) yields a working connection token.
        const tok = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: clientRedirectUri,
            client_id: clientId,
            code_verifier: verifier,
        });
        expect(tok.status).toBe(200);
        const accessToken = tok.body.access_token as string;
        expect(accessToken).toMatch(/^wmc_/);

        // The connection token authenticates against /mcp.
        const resolved = await authManager.resolveConnectionToken(accessToken);
        expect(resolved).toBeDefined();

        // 6. Code is single-use.
        const replay = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: clientRedirectUri,
            client_id: clientId,
            code_verifier: verifier,
        });
        expect(replay.status).toBe(400);
        expect(replay.body.error).toBe('invalid_grant');
    });

    it('rejects the token exchange with a wrong PKCE verifier', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const clientId = reg.body.client_id as string;
        const good = pkce();
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: clientId,
            redirect_uri: clientRedirectUri,
            code_challenge: good.challenge,
            code_challenge_method: 'S256',
        });
        const connectUrl = new URL(auth.headers.location!, 'https://mcp.example.com');
        const connect = await consent(app, connectUrl);
        const state = new URL(connect.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        const cb = await request(app).get('/oauth/callback').query({ code: 'wrike-code-2', state });
        const code = new URL(cb.headers.location!).searchParams.get('code')!;

        const bad = pkce();
        const tok = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: clientRedirectUri,
            client_id: clientId,
            code_verifier: bad.verifier,
        });
        expect(tok.status).toBe(400);
        expect(tok.body.error).toBe('invalid_grant');
    });

    it('rejects a registered client with an unregistered redirect_uri', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const reg = await request(app).post('/oauth/register').send({
            redirect_uris: ['https://claude.ai/callback'],
        });
        const clientId = reg.body.client_id as string;
        const { challenge } = pkce();
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: clientId,
            redirect_uri: 'https://evil.example/callback',
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });
        expect(auth.status).toBe(400);
        expect(auth.body.error).toBe('invalid_redirect_uri');
    });

    it('rejects an unregistered client_id', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: 'attacker-unregistered',
            redirect_uri: 'https://attacker.example/callback',
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
        });
        expect(auth.status).toBe(401);
        expect(auth.body.error).toBe('invalid_client');
    });

    it('issues exactly one connection token per MCP authorization', async () => {
        const { app, authManager, storePath } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const clientId = reg.body.client_id as string;
        const { verifier, challenge } = pkce();
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: clientId,
            redirect_uri: clientRedirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });
        const connectUrl = new URL(auth.headers.location!, 'https://mcp.example.com');
        const connect = await consent(app, connectUrl);
        const state = new URL(connect.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        const cb = await request(app).get('/oauth/callback').query({ code: 'wrike-code-x', state });
        expect(cb.status).toBe(302);
        const code = new URL(cb.headers.location!).searchParams.get('code')!;
        const tok = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: clientRedirectUri,
            client_id: clientId,
            code_verifier: verifier,
        });
        expect(tok.status).toBe(200);
        // Exactly one connection-token hash exists for the user — the Wrike
        // callback must NOT mint one; only the token exchange does.
        const users = await authManager.listUsers();
        expect(users).toHaveLength(1);
        const store = new EncryptedTokenStore(key, storePath);
        const user = await store.getUser(users[0]);
        expect(user?.connectionTokens).toHaveLength(1);
    });

    it('requires PKCE, reporting the failure at the client redirect_uri', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const reg = await request(app)
            .post('/oauth/register')
            .send({ redirect_uris: ['https://claude.ai/callback'] });
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: reg.body.client_id as string,
            redirect_uri: 'https://claude.ai/callback',
            state: 'client-state-pkce',
        });
        // RFC 6749 4.1.2.1: redirect_uri is registered, so the error goes back
        // to the client rather than rendering as JSON in the browser.
        expect(auth.status).toBe(302);
        const back = new URL(auth.headers.location!);
        expect(back.origin + back.pathname).toBe('https://claude.ai/callback');
        expect(back.searchParams.get('error')).toBe('invalid_request');
        expect(back.searchParams.get('error_description')).toContain('PKCE');
        expect(back.searchParams.get('state')).toBe('client-state-pkce');
        expect(back.searchParams.get('code')).toBeNull();
    });

    it('keeps JSON (no redirect) when the redirect_uri itself is not validated', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const reg = await request(app)
            .post('/oauth/register')
            .send({ redirect_uris: ['https://claude.ai/callback'] });
        // Unregistered redirect_uri: redirecting to it is exactly what must not
        // happen, so the error stays a JSON body.
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: reg.body.client_id as string,
            redirect_uri: 'https://evil.example/callback',
        });
        expect(auth.status).toBe(400);
        expect(auth.body.error).toBe('invalid_redirect_uri');
    });

    it('rejects a resource indicator for a different server (RFC 8707)', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com/wrike'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: reg.body.client_id as string,
            redirect_uri: clientRedirectUri,
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
            resource: 'https://someone-else.example/mcp',
        });
        expect(auth.status).toBe(302);
        const back = new URL(auth.headers.location!);
        expect(back.origin + back.pathname).toBe(clientRedirectUri);
        expect(back.searchParams.get('error')).toBe('invalid_target');
    });

    it('accepts a resource indicator that identifies this server', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com/wrike'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        // The base URL itself and a path beneath it (the /mcp endpoint) both
        // identify this resource server.
        for (const resource of ['https://mcp.example.com/wrike', 'https://mcp.example.com/wrike/mcp']) {
            const auth = await request(app).get('/oauth/authorize').query({
                client_id: reg.body.client_id as string,
                redirect_uri: clientRedirectUri,
                code_challenge: pkce().challenge,
                code_challenge_method: 'S256',
                resource,
            });
            expect(auth.status).toBe(302);
            expect(new URL(auth.headers.location!).pathname).toBe('/wrike/connect');
        }
    });

    it('does not mint a code when consent lands in a different user slot', async () => {
        const { app, authManager } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: reg.body.client_id as string,
            redirect_uri: clientRedirectUri,
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
        });
        const connectUrl = new URL(auth.headers.location!, 'https://mcp.example.com');
        // Crafted confirm: the attacker's resume token paired with a handle
        // other than the one the authorization was started for.
        const connect = await consent(app, connectUrl, { user: 'someone-else' });
        const state = new URL(connect.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        const cb = await request(app).get('/oauth/callback').query({ code: 'wrike-code-mismatch', state });

        // No code is handed to the client; the user gets their own token page.
        expect(cb.status).toBe(200);
        expect(cb.text).toContain('Authorization: Bearer');
        expect(await authManager.listUsers()).toEqual(['someone-else']);
    });

    it('rejects DCR without http(s) redirect_uris', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [] });
        expect(reg.status).toBe(400);
        expect(reg.body.error).toBe('invalid_redirect_uri');
    });

    it('rejects redirect_uris that pass the scheme prefix but do not parse', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        // 'https://' has the right prefix but no host: registering it would put
        // a value in the allow-list that throws when constructed as a URL.
        for (const u of ['https://', 'http://', 'https://?', 'https://#x']) {
            const reg = await request(app).post('/oauth/register').send({ redirect_uris: [u] });
            expect(reg.status).toBe(400);
            expect(reg.body.error).toBe('invalid_redirect_uri');
        }
    });

    it('never answers a handled authorize error with a 500', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const clientId = reg.body.client_id as string;
        // Every handled error is either an error redirect or a 4xx JSON body.
        // The unparseable-URI case cannot be reached from here now that
        // registration rejects those, so the try/catch around the redirect
        // construction is defence only; this pins the observable contract.
        const cases: Array<Record<string, string>> = [
            { client_id: clientId, redirect_uri: clientRedirectUri }, // no PKCE
            { client_id: clientId, redirect_uri: clientRedirectUri, code_challenge: 'x', resource: 'https://other.example' },
            { client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: 'x' },
            { client_id: 'never-registered', redirect_uri: clientRedirectUri, code_challenge: 'x' },
        ];
        for (const query of cases) {
            const auth = await request(app).get('/oauth/authorize').query(query);
            expect(auth.status).not.toBe(500);
            expect([302, 400, 401]).toContain(auth.status);
        }
    });

    it('rejects malformed DCR bodies with 400, not 500', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        // Public endpoint: a non-array redirect_uris must not reach .filter.
        for (const redirect_uris of ['https://claude.ai/callback', 42, {}, null]) {
            const reg = await request(app).post('/oauth/register').send({ redirect_uris });
            expect(reg.status).toBe(400);
            expect(reg.body.error).toBe('invalid_redirect_uri');
        }
    });

    it('names the requesting client on the consent screen, HTML-escaped', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({
            client_name: '<img src=x onerror=alert(1)>Evil',
            redirect_uris: [clientRedirectUri],
        });
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: reg.body.client_id as string,
            redirect_uri: clientRedirectUri,
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
        });
        const connectUrl = new URL(auth.headers.location!, 'https://mcp.example.com');
        const shown = await request(app).get('/connect').query({
            user: connectUrl.searchParams.get('user')!,
            resume: connectUrl.searchParams.get('resume')!,
        });
        expect(shown.status).toBe(200);
        // client_name is attacker-controlled: displayed, never rendered as markup.
        expect(shown.text).not.toContain('<img src=x');
        expect(shown.text).toContain('&lt;img src=x');
        expect(shown.text).toContain('not verified');
    });

    it('will not skip the consent screen without the matching nonce cookie', async () => {
        const { app, authManager } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: reg.body.client_id as string,
            redirect_uri: clientRedirectUri,
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
        });
        const connectUrl = new URL(auth.headers.location!, 'https://mcp.example.com');

        // A cross-site auto-submitted form carries no SameSite=Lax cookie.
        const forged = await request(app).post('/connect/confirm').type('form').send({
            resume: connectUrl.searchParams.get('resume')!,
            user: connectUrl.searchParams.get('user')!,
            nonce: 'guessed',
        });
        expect(forged.status).toBe(403);
        expect(await authManager.listUsers()).toEqual([]);
    });

    it('refuses to take over a handle that is already connected', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        // First user claims the handle.
        const first = await request(app).get('/connect').query({ user: 'ben' });
        const state = new URL(first.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        expect((await request(app).get('/oauth/callback').query({ code: 'w1', state })).status).toBe(200);

        // A second browser must not repoint that slot at a different Wrike account:
        // connection tokens already issued for 'ben' resolve through it.
        const second = await request(app).get('/connect').query({ user: 'ben' });
        expect(second.status).toBe(409);
        expect(second.text).toContain('already connected');
    });

    it('revocation endpoint revokes the presented token', async () => {
        const { app, authManager } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const clientId = reg.body.client_id as string;
        const { verifier, challenge } = pkce();
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: clientId,
            redirect_uri: clientRedirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });
        const connectUrl = new URL(auth.headers.location!, 'https://mcp.example.com');
        const connect = await consent(app, connectUrl);
        const state = new URL(connect.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        const cb = await request(app).get('/oauth/callback').query({ code: 'wrike-code-rev', state });
        const code = new URL(cb.headers.location!).searchParams.get('code')!;
        const tok = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: clientRedirectUri,
            client_id: clientId,
            code_verifier: verifier,
        });
        const accessToken = tok.body.access_token as string;
        expect(await authManager.resolveConnectionToken(accessToken)).toBeDefined();

        const res = await request(app).post('/oauth/revoke-token').send({ token: accessToken });
        expect(res.status).toBe(200);
        // The endpoint is advertised in the discovery document, so it must
        // really revoke rather than silently succeed.
        expect(await authManager.resolveConnectionToken(accessToken)).toBeUndefined();
    });

    it('marks the token response no-store (RFC 6749 5.1)', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const clientRedirectUri = 'https://claude.ai/callback';
        const reg = await request(app).post('/oauth/register').send({ redirect_uris: [clientRedirectUri] });
        const clientId = reg.body.client_id as string;
        const { verifier, challenge } = pkce();
        const auth = await request(app).get('/oauth/authorize').query({
            client_id: clientId,
            redirect_uri: clientRedirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });
        const connectUrl = new URL(auth.headers.location!, 'https://mcp.example.com');
        const connect = await consent(app, connectUrl);
        const state = new URL(connect.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        const cb = await request(app).get('/oauth/callback').query({ code: 'wrike-code-cc', state });
        const code = new URL(cb.headers.location!).searchParams.get('code')!;
        const tok = await request(app).post('/oauth/token').send({
            grant_type: 'authorization_code',
            code,
            redirect_uri: clientRedirectUri,
            client_id: clientId,
            code_verifier: verifier,
        });
        expect(tok.status).toBe(200);
        expect(tok.headers['cache-control']).toContain('no-store');
    });

    it('does not let two concurrent flows claim the same handle', async () => {
        const { app, authManager } = makeApp(oauthConfig('https://mcp.example.com'));
        // Both browsers pass the /connect 409 check before either completes
        // Wrike consent — the guard there is only check-then-act.
        const first = await request(app).get('/connect').query({ user: 'ben' });
        const second = await request(app).get('/connect').query({ user: 'ben' });
        expect(first.status).toBe(302);
        expect(second.status).toBe(302);
        const s1 = new URL(first.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        const s2 = new URL(second.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;

        const cb1 = await request(app).get('/oauth/callback').query({ code: 'race-1', state: s1 });
        expect(cb1.status).toBe(200);
        // The loser must not overwrite the winner's tokens: that would repoint
        // every connection token already issued for 'ben' at another account.
        const cb2 = await request(app).get('/oauth/callback').query({ code: 'race-2', state: s2 });
        expect(cb2.status).toBe(409);
        expect(await authManager.listUsers()).toEqual(['ben']);
    });

    it('returns 200 for an unknown token (RFC 7009 2.2)', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const res = await request(app).post('/oauth/revoke-token').send({ token: 'wmc_whatever' });
        expect(res.status).toBe(200);
    });
});

describe('async handler failures', () => {
    it('turns a store failure into a 500 rather than an unhandled rejection', async () => {
        const { app, authManager } = makeApp(oauthConfig('https://mcp.example.com'));
        const rejections: unknown[] = [];
        const onRejection = (e: unknown) => rejections.push(e);
        process.on('unhandledRejection', onRejection);
        try {
            // Simulates the encrypted store failing to read/decrypt.
            authManager.resolveConnectionToken = async () => {
                throw new Error('store unreadable: SECRET-CLIENT-SECRET');
            };
            const res = await request(app).post('/oauth/revoke-token').send({ token: 'wmc_x' });
            // Express 5 forwards async rejections to the error middleware, so the
            // process survives and the message is redacted on the way out.
            expect(res.status).toBe(500);
            expect(JSON.stringify(res.body)).not.toContain('SECRET-CLIENT-SECRET');
            await new Promise((r) => setImmediate(r));
            expect(rejections).toEqual([]);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    });
});

describe('plain connect flow is unchanged', () => {
    it('still shows the one-time token page without a resume token', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const connect = await request(app).get('/connect');
        const state = new URL(connect.headers.location!, 'https://login.wrike.com').searchParams.get('state')!;
        const cb = await request(app).get('/oauth/callback').query({ code: 'wrike-code-3', state });
        expect(cb.status).toBe(200);
        expect(cb.text).toContain('Authorization: Bearer');
    });
});