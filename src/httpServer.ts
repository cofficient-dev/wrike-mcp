import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { AuthManager } from './auth/authManager.js';
import { OAuthStateManager, WRIKE_AUTHORIZE_URL, exchangeCodeForTokens, toStoredTokens } from './auth/oauth.js';
import { type AppConfig } from './config.js';
import { redact, errorMessage } from './redact.js';
import type { SessionManager } from './transport.js';

/**
 * Web-exposed endpoints:
 *   GET  /healthz         — liveness
 *   GET  /connect         — start per-user Wrike OAuth (oauth mode)
 *   GET  /oauth/callback  — code exchange; issues the user's connection token (oauth mode)
 *   POST /revoke          — user removes their own connection
 *   ALL  /mcp             — MCP Streamable HTTP (requires Bearer connection token)
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
    const oauthState = new OAuthStateManager(
        config.auth.mode === 'oauth' ? config.auth.clientSecret : 'unused'
    );

    // Rate limiting (simple in-memory; suitable for a single-instance deployment).
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
        app.get('/connect', rateLimit(10), (req, res) => {
            // The user supplies any handle they like (or we generate one); it only
            // labels their entry — authentication is Wrike's own login page.
            const rawHandle = typeof req.query.user === 'string' ? req.query.user.trim() : '';
            const handle = rawHandle.replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 64);
            const pendingUserId = handle || `user-${randomHex(6)}`;
            const state = oauthState.issue(pendingUserId);
            const params = new URLSearchParams({
                client_id: oauthAuth.clientId,
                response_type: 'code',
                redirect_uri: oauthAuth.redirectUri,
                state,
            });
            if (oauthAuth.scopes.length > 0) params.set('scope', oauthAuth.scopes.join(','));
            res.redirect(302, `${WRIKE_AUTHORIZE_URL}?${params.toString()}`);
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
                await authManager.storeUserTokens(userId, tokens);
                const connectionToken = await authManager.issueConnectionToken(userId);
                // Connection token is shown exactly once; it is stored only as a hash.
                res.type('html').send(
                    `<!doctype html><html><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">` +
                    `<h2>Wrike connected</h2>` +
                    `<p>Add this MCP server to your client with the header:</p>` +
                    `<p><code>Authorization: Bearer <strong>${connectionToken}</strong></code></p>` +
                    `<p style="color:#a33">This token is shown only once. Store it in your MCP client now.</p>` +
                    `<p>User handle: <code>${escapeHtml(userId)}</code></p>` +
                    `</body></html>`
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

function randomHex(n: number): string {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * 16)];
    return out;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}