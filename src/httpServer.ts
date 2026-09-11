import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthManager } from './auth/authManager.js';
import { OAuthStateManager, WRIKE_AUTHORIZE_URL, exchangeCodeForTokens, toStoredTokens } from './auth/oauth.js';
import { McpOAuthServer, McpOauthError } from './auth/mcpOauth.js';
import { type AppConfig } from './config.js';
import { redact, errorMessage, registerSecret } from './redact.js';
import type { SessionManager } from './transport.js';

/**
 * Web-exposed endpoints:
 *   GET  /healthz              — liveness
 *   GET  /connect              — start per-user Wrike OAuth (oauth mode)
 *   POST /connect/confirm      — MCP consent screen confirmation (nonce-bound)
 *   GET  /oauth/callback       — code exchange; issues the user's connection token (oauth mode)
 *   POST /revoke               — user removes their own connection
 *   ALL  /mcp                  — MCP Streamable HTTP (requires Bearer connection token)
 *
 * MCP-native OAuth (oauth mode with PUBLIC_BASE_URL set):
 *   GET  /.well-known/oauth-protected-resource[/<issuer path>]
 *   GET  /.well-known/oauth-authorization-server[/<issuer path>]
 *   POST /oauth/register       — dynamic client registration (RFC 7591)
 *   GET  /oauth/authorize      — authorization endpoint (S256 PKCE required)
 *   POST /oauth/token          — code + verifier -> connection token
 *   POST /oauth/revoke-token   — RFC 7009 revocation
 *
 * Security properties:
 *  - Each user authorizes with their OWN Wrike account; the server stores
 *    per-user tokens only in the AES-256-GCM encrypted store.
 *  - Connection tokens (server-local credentials, shown once at /connect)
 *    are stored only as HMAC hashes and compared in constant time.
 *  - Client secret lives only in process memory (env var).
 *  - No endpoint, error, or log returns a token/secret; all outgoing text
 *    passes through redact().
 */


/**
 * Nonce cookie binding the MCP consent screen to the browser that saw it.
 *
 * Over HTTPS the `__Host-` prefix is used: a browser only accepts such a
 * cookie when it is Secure, Path=/ and has no Domain attribute, which makes
 * the name unforgeable from a sibling subdomain. Without it, anyone
 * controlling a sibling of the parent domain could plant a nonce of their
 * choosing, pair it with their own resume token in an auto-submitted form,
 * and skip the consent screen entirely. The prefix requires Secure, so plain
 * HTTP (local development, tests) falls back to the bare name.
 */
const CONSENT_COOKIE_BASE = 'wrike_mcp_consent';

export interface HttpServerDeps {
    config: AppConfig;
    authManager: AuthManager;
    sessionManager: SessionManager;
    fetchImpl?: typeof fetch;
}

export function createHttpApp({
    config,
    authManager,
    sessionManager,
    fetchImpl = fetch,
}: HttpServerDeps): Express {
    const app = express();
    // Scrub the configured secret verbatim from any outgoing error text: the
    // shape-based patterns in redact() do not match a bare secret value.
    registerSecret(config.auth.mode === 'oauth' ? config.auth.clientSecret : config.auth.pat);
    const oauthState = new OAuthStateManager(
        config.auth.mode === 'oauth' ? config.auth.clientSecret : 'unused'
    );

    // Rate limiting (simple in-memory; suitable for a single-instance deployment).
    const publicBaseUrl = config.publicBaseUrl ?? '';
    // MCP-native OAuth authorization server (only in oauth mode with PUBLIC_BASE_URL set).
    const mcpOauth =
        config.auth.mode === 'oauth' && config.publicBaseUrl
            ? new McpOAuthServer(config.auth, authManager, publicBaseUrl)
            : undefined;
    // (publicBaseUrl declared above)

    // __Host- requires Secure, so it is only usable when the public origin is
    // HTTPS; over plain HTTP the browser would reject the cookie outright.
    const cookieSecure = publicBaseUrl.startsWith('https://');
    const consentCookie = cookieSecure ? `__Host-${CONSENT_COOKIE_BASE}` : CONSENT_COOKIE_BASE;

    const hits = new Map<string, { count: number; reset: number }>();
    const rateLimit = (perMinute: number) => (req: Request, res: Response, next: NextFunction) => {
        const key = req.ip ?? 'unknown';
        const now = Date.now();
        const bucket = hits.get(key) ?? { count: 0, reset: now + 60_000 };
        if (now > bucket.reset) {
            bucket.count = 0;
            bucket.reset = now + 60_000;
        }
        bucket.count += 1;
        hits.set(key, bucket);
        if (bucket.count > perMinute) {
            res.status(429).json({ error: 'rate_limited', errorDescription: 'Too many requests' });
            return;
        }
        next();
    };

    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: false }));

    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok' });
    });

    // --- MCP OAuth discovery (RFC 8414 / MCP spec) -------------------------
    // Advertised only when PUBLIC_BASE_URL is configured (needed behind a
    // path-prefixed or TLS-terminating proxy).
    // RFC 8414 3.1 / RFC 9728 3.1 insert the well-known segment between the
    // host and the issuer's path, so for issuer https://host/wrike a compliant
    // client fetches https://host/.well-known/oauth-authorization-server/wrike.
    // Behind a path-prefix proxy that route is host-rooted and needs its own
    // proxy rule (see deploy/README.md); these regexes accept the trailing
    // issuer path either way, so the app answers whichever form arrives.
    const wellKnown = (name: string) => new RegExp(`^/\\.well-known/${name}(?:/.*)?$`);

    app.get(wellKnown('oauth-protected-resource'), (_req, res) => {
        if (!mcpOauth) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        res.json(mcpOauth.protectedResourceMetadata(publicBaseUrl));
    });

    app.get(wellKnown('oauth-authorization-server'), (_req, res) => {
        if (!mcpOauth) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        res.json(mcpOauth.authorizationServerMetadata(publicBaseUrl));
    });

    // --- MCP OAuth endpoints (oauth mode only) ------------------------------
    if (mcpOauth) {
        // Dynamic client registration (RFC 7591).
        app.post('/oauth/register', rateLimit(10), (req, res) => {
            try {
                const client = mcpOauth.registerClient(req.body ?? {});
                res.status(201).json(client);
            } catch (err) {
                if (err instanceof McpOauthError) {
                    res.status(err.status).json({ error: err.code, error_description: err.description });
                    return;
                }
                res.status(500).json({ error: 'server_error' });
            }
        });

        // Authorization endpoint: sends the user to the Wrike connect flow.
        app.get('/oauth/authorize', rateLimit(10), (req, res) => {
            const q = req.query as Record<string, string | undefined>;
            try {
                const { redirectUrl } = mcpOauth.beginAuthorization({
                    clientId: q.client_id ?? '',
                    redirectUri: q.redirect_uri ?? '',
                    codeChallenge: q.code_challenge,
                    codeChallengeMethod: q.code_challenge_method,
                    state: q.state,
                    resource: q.resource,
                });
                res.redirect(302, redirectUrl);
            } catch (err) {
                if (err instanceof McpOauthError) {
                    // RFC 6749 §4.1.2.1: once the redirect_uri is validated, the
                    // error belongs at the client's redirect_uri — otherwise the
                    // MCP client never learns why, and the user sees raw JSON.
                    // Unknown client_id / redirect_uri stay JSON: redirecting to
                    // an unvalidated URI is exactly what must not happen.
                    // Belt and braces: registration rejects unparseable URIs,
                    // but a throw here would turn a handled OAuth error into a
                    // 500 and lose the error the client needs.
                    if (err.redirectSafe && q.redirect_uri) {
                        try {
                            const back = new URL(q.redirect_uri);
                            back.searchParams.set('error', err.code);
                            back.searchParams.set('error_description', err.description);
                            if (q.state) back.searchParams.set('state', q.state);
                            res.redirect(302, back.toString());
                            return;
                        } catch {
                            /* not a usable redirect target — fall through to JSON */
                        }
                    }
                    res.status(err.status).json({ error: err.code, error_description: err.description });
                    return;
                }
                res.status(500).json({ error: 'server_error' });
            }
        });

        // Token endpoint: code + PKCE verifier -> connection token.
        app.post('/oauth/token', rateLimit(20), async (req, res) => {
            // RFC 6749 5.1: token responses must not be cached — this body
            // carries the connection token.
            res.set('Cache-Control', 'no-store');
            res.set('Pragma', 'no-cache');
            try {
                const token = await mcpOauth.exchangeCode(req.body ?? {});
                res.json(token);
            } catch (err) {
                if (err instanceof McpOauthError) {
                    res.status(err.status).json({
                        error: err.code,
                        error_description: err.description,
                    });
                    return;
                }
                res.status(500).json({ error: 'server_error', error_description: redact(errorMessage(err)) });
            }
        });

        // Revocation endpoint (RFC 7009). Advertised in the discovery document,
        // so it must actually revoke: presenting the token is authorisation to
        // revoke it. Unknown/invalid tokens still return 200 per RFC 7009 §2.2,
        // which also avoids confirming whether a token exists.
        app.post('/oauth/revoke-token', rateLimit(20), async (req, res) => {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const token = typeof body.token === 'string' ? body.token : undefined;
            // Single implementation in McpOAuthServer.revoke: revocation
            // semantics must not exist in two places that can drift.
            if (token) await mcpOauth.revoke(token);
            res.status(200).end();
        });
    }

    /** Extracts the Bearer connection token from the request. */
    function bearerToken(req: Request): string | undefined {
        const header = req.headers.authorization;
        if (!header) return undefined;
        const m = /^Bearer\s+(.+)$/i.exec(header);
        return m ? m[1]!.trim() : undefined;
    }

    /** Resolves a request to a user ID (PAT mode: the single configured user). */
    async function resolveUser(req: Request): Promise<string | undefined> {
        if (config.auth.mode === 'pat') {
            return AuthManager.PAT_USER_ID;
        }
        const token = bearerToken(req);
        if (!token) return undefined;
        return authManager.resolveConnectionToken(token);
    }

    if (config.auth.mode === 'oauth') {
        const oauthAuth = config.auth;

        // --- Per-user connection flow ------------------------------------------
        /** Sends the user on to Wrike's own login/consent page. */
        function redirectToWrike(res: Response, pendingUserId: string, resume?: string): void {
            const state = oauthState.issue(pendingUserId, resume);
            const params = new URLSearchParams({
                client_id: oauthAuth.clientId,
                response_type: 'code',
                redirect_uri: oauthAuth.redirectUri,
                state,
            });
            if (oauthAuth.scopes.length > 0) params.set('scope', oauthAuth.scopes.join(','));
            res.redirect(302, `${WRIKE_AUTHORIZE_URL}?${params.toString()}`);
        }

        /**
         * Refuses to hand an existing user slot to a different browser: tokens
         * are stored by handle, so silently overwriting a slot would repoint
         * every connection token already issued for it at the new person's
         * Wrike account. Users re-connecting must revoke first.
         */
        async function handleIsTaken(handle: string): Promise<boolean> {
            if (!handle) return false;
            return (await authManager.listUsers()).includes(handle);
        }

        app.get('/connect', rateLimit(10), async (req, res) => {
            // The user supplies any handle they like (or we generate one); it only
            // labels their entry — authentication is Wrike's own login page.
            const rawHandle = typeof req.query.user === 'string' ? req.query.user.trim() : '';
            const handle = rawHandle.replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 64);
            const pendingUserId = handle || `user-${randomHex(6)}`;
            // MCP OAuth flow: when the client sent the user here via /oauth/authorize,
            // a signed resume token links this Wrike consent back to the client's
            // pending authorization.
            const resume = typeof req.query.resume === 'string' ? req.query.resume : undefined;

            if (await handleIsTaken(handle)) {
                res.status(409).type('html').send(
                    page(
                        'Handle already in use',
                        `<p>The handle <code>${escapeHtml(handle)}</code> is already connected.</p>` +
                        `<p>Pick a different handle, or revoke the existing connection first ` +
                        `(<code>POST /revoke</code> with that connection token as the Bearer header).</p>`
                    )
                );
                return;
            }

            // MCP OAuth: show who is asking before sending the user to Wrike.
            // Without this the only consent screen is Wrike's page for THIS
            // server's app, so a client that self-registered via open DCR and
            // phished the authorize URL would be invisible to the user.
            if (resume && mcpOauth) {
                const pending = mcpOauth.describePending(resume);
                if (!pending) {
                    res.status(400).type('html').send(
                        page('Link expired', '<p>This sign-in link has expired. Start again from your MCP client.</p>')
                    );
                    return;
                }
                const nonce = randomToken();
                res.cookie(consentCookie, nonce, {
                    httpOnly: true,
                    sameSite: 'lax',
                    secure: cookieSecure,
                    maxAge: 10 * 60 * 1000,
                    path: '/',
                });
                const who = pending.clientName
                    ? `<strong>${escapeHtml(pending.clientName)}</strong>`
                    : '<strong>An MCP client</strong>';
                res.type('html').send(
                    page(
                        'Authorize MCP client',
                        `<p>${who} is asking to connect to your Wrike account through this server.</p>` +
                        `<dl><dt>Client name</dt><dd>${escapeHtml(pending.clientName ?? '(not supplied)')}</dd>` +
                        `<dt>Client ID</dt><dd><code>${escapeHtml(pending.clientId)}</code></dd>` +
                        `<dt>Redirects to</dt><dd><code>${escapeHtml(pending.redirectUri)}</code></dd></dl>` +
                        `<p style="color:#a33">The client name is supplied by the client and is not verified. ` +
                        `If you did not start this from your MCP client, close this page.</p>` +
                        `<form method="post" action="${escapeHtml(publicBaseUrl)}/connect/confirm">` +
                        `<input type="hidden" name="resume" value="${escapeHtml(resume)}">` +
                        `<input type="hidden" name="user" value="${escapeHtml(pendingUserId)}">` +
                        `<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">` +
                        `<button type="submit">Continue to Wrike</button></form>`
                    )
                );
                return;
            }

            redirectToWrike(res, pendingUserId, resume);
        });

        // Consent confirmation for the MCP flow. The nonce must match the
        // cookie set when the consent screen rendered; SameSite=Lax means a
        // cross-site auto-submitted form does not carry it, so the consent
        // screen cannot be skipped from an attacker's page.
        app.post('/connect/confirm', rateLimit(10), async (req, res) => {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const resume = typeof body.resume === 'string' ? body.resume : '';
            const nonce = typeof body.nonce === 'string' ? body.nonce : '';
            const rawHandle = typeof body.user === 'string' ? body.user.trim() : '';
            const handle = rawHandle.replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 64);
            const cookie = readCookie(req, consentCookie);

            if (!cookie || !nonce || !timingSafeEqualStr(cookie, nonce)) {
                res.status(403).type('html').send(
                    page('Could not confirm', '<p>Consent could not be confirmed. Start again from your MCP client.</p>')
                );
                return;
            }
            res.clearCookie(consentCookie, { path: '/' });
            if (!resume || !mcpOauth?.describePending(resume)) {
                res.status(400).type('html').send(
                    page('Link expired', '<p>This sign-in link has expired. Start again from your MCP client.</p>')
                );
                return;
            }
            if (await handleIsTaken(handle)) {
                res.status(409).type('html').send(page('Handle already in use', '<p>Start again from your MCP client.</p>'));
                return;
            }
            redirectToWrike(res, handle || `user-${randomHex(6)}`, resume);
        });

        app.get('/oauth/callback', rateLimit(10), async (req, res) => {
            const { code, state, error } = req.query as Record<string, string | undefined>;
            if (error) {
                res.status(400).send('Authorization was denied or failed. You can retry at /connect.');
                return;
            }
            const verified = state ? oauthState.verify(state) : { valid: false };
            if (!code || !verified.valid) {
                res.status(400).send('Invalid or expired state parameter. Restart at /connect.');
                return;
            }
            const userId = verified.pendingUserId ?? `user-${randomHex(6)}`;
            try {
                const tokenResp = await exchangeCodeForTokens(oauthAuth, code, fetchImpl);
                const tokens = toStoredTokens(tokenResp, 'www.wrike.com');
                // Claim the slot atomically. The 409 at /connect is only a
                // check-then-act: two browsers can both pass it before either
                // finishes Wrike consent, and the loser would otherwise
                // overwrite the winner's tokens under the same handle.
                if (!(await authManager.storeUserTokensIfAbsent(userId, tokens))) {
                    res.status(409).type('html').send(
                        page(
                            'Handle already in use',
                            `<p>The handle <code>${escapeHtml(userId)}</code> was connected by someone else ` +
                            `while you were authorizing.</p><p>Start again at <code>/connect</code> with a different handle.</p>`
                        )
                    );
                    return;
                }
                // MCP OAuth flow: redirect straight back to the MCP client with
                // the one-time code (client then exchanges it at /oauth/token).
                if (verified.pendingResume && mcpOauth) {
                    // userId is passed so the code is minted only when the slot
                    // the Wrike tokens landed in is the one the authorization
                    // was started for (/connect takes its handle from the query).
                    const back = await mcpOauth.completeWrikeAuthorization(verified.pendingResume, userId);
                    if (back) {
                        // Connection token is minted only at /oauth/token
                        // exchange (exchangeCode) — one token per authorization.
                        res.redirect(302, back.redirectUrl);
                        return;
                    }
                }
                const connectionToken = await authManager.issueConnectionToken(userId);
                // Connection token is shown exactly once; it is stored only as a hash.
                // This page shows the connection token in the clear; keep it
                // out of intermediary and browser caches.
                res.set('Cache-Control', 'no-store');
                res.set('Pragma', 'no-cache');
                res.type('html').send(
                    page(
                        'Wrike connected',
                        `<p>Add this MCP server to your client with the header:</p>` +
                        `<p><code>Authorization: Bearer <strong>${escapeHtml(connectionToken)}</strong></code></p>` +
                        `<p style="color:#a33">This token is shown only once. Store it in your MCP client now.</p>` +
                        `<p>User handle: <code>${escapeHtml(userId)}</code></p>`
                    )
                );
            } catch (err) {
                res.status(502).send(redact(`Token exchange failed: ${errorMessage(err)}`));
            }
        });

        // --- Self-service revoke -----------------------------------------------
        app.post('/revoke', rateLimit(10), async (req, res) => {
            const userId = await resolveUser(req);
            if (!userId) {
                res.status(401).json({ error: 'not_authorized', errorDescription: 'Provide your connection token as Bearer header' });
                return;
            }
            await authManager.revokeUser(userId);
            res.json({ status: 'revoked' });
        });
    }

    // --- MCP endpoint -------------------------------------------------------
    app.all('/mcp', rateLimit(120), async (req, res) => {
        try {
            const userId = await resolveUser(req);
            if (!userId) {
                res.setHeader('WWW-Authenticate', 'Bearer realm="wrike-mcp"');
                res.status(401).json({
                    error: 'not_authorized',
                    errorDescription:
                        config.auth.mode === 'oauth'
                            ? 'Connect your Wrike account at /connect and use the issued token as a Bearer header.'
                            : 'No credentials configured.',
                });
                return;
            }
            (req as Request & { resolvedUserId?: string }).resolvedUserId = userId;
            await sessionManager.handleRequest(req, res);
        } catch (err) {
            res.status(500).json({ error: 'internal_error', errorDescription: redact(errorMessage(err)) });
        }
    });

    // 404 + error handling with redaction.
    app.use((_req, res) => {
        res.status(404).json({ error: 'not_found' });
    });
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'internal_error', errorDescription: redact(message) });
    });

    return app;
}

/** User-slot suffix. Crypto RNG: Math.random is predictable across requests. */
function randomHex(n: number): string {
    return randomBytes(Math.ceil(n / 2))
        .toString('hex')
        .slice(0, n);
}

function randomToken(): string {
    return randomBytes(32).toString('base64url');
}

/** Constant-time string compare for equal-length secrets (length is not secret). */
function timingSafeEqualStr(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * HTML-escapes untrusted text. Quotes are escaped too: these values land in
 * attribute contexts (hidden form fields) as well as element text.
 */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Minimal shared page chrome for the browser-facing endpoints. */
function page(title: string, body: string): string {
    return (
        `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
        `<body style="font-family:system-ui;max-width:40rem;margin:3rem auto">` +
        `<h2>${escapeHtml(title)}</h2>${body}</body></html>`
    );
}