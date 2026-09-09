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

        // 3. /connect redirects to Wrike; simulate Wrike's callback with the state.
        const connect = await request(app).get('/connect').query({
            user: connectUrl.searchParams.get('user')!,
            resume,
        });
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
        const resume = connectUrl.searchParams.get('resume')!;
        const connect = await request(app).get('/connect').query({
            user: connectUrl.searchParams.get('user')!,
            resume,
        });
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
        const connect = await request(app).get('/connect').query({
            user: connectUrl.searchParams.get('user')!,
            resume: connectUrl.searchParams.get('resume')!,
        });
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
        // Crafted /connect: the attacker's resume token paired with a handle
        // other than the one the authorization was started for.
        const connect = await request(app).get('/connect').query({
            user: 'someone-else',
            resume: connectUrl.searchParams.get('resume')!,
        });
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

    it('revocation endpoint returns 200 (no-op by design)', async () => {
        const { app } = makeApp(oauthConfig('https://mcp.example.com'));
        const res = await request(app).post('/oauth/revoke-token').send({ token: 'wmc_whatever' });
        expect(res.status).toBe(200);
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