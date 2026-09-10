import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import type { AuthManager } from './authManager.js';
import type { OAuthConfig } from '../config.js';

/**
 * MCP-native OAuth 2.1 authorization server (RFC 8414 / MCP spec).
 *
 * Lets MCP clients (Claude etc.) sign in natively instead of pasting a
 * Bearer header: the client drives the standard authorization-code + PKCE
 * flow against THIS server; behind it we run the existing per-user Wrike
 * /connect flow and issue the user's existing connection token as the
 * OAuth access token.
 *
 * Nothing new touches the encrypted store: the access token IS the
 * per-user connection token (stored only as a hash), and no refresh tokens
 * are issued (connection tokens do not expire; users revoke at /revoke).
 */

/** Advertises this server as an OAuth protected resource (MCP discovery). */
export function protectedResourceMetadata(baseUrl: string): object {
    return {
        resource: baseUrl,
        authorization_servers: [baseUrl],
    };
}

/** RFC 8414 authorization-server metadata for this server. */
export function authorizationServerMetadata(baseUrl: string, scopes: string[]): object {
    return {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        revocation_endpoint: `${baseUrl}/oauth/revoke-token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        // DCR issues no client_secret and the token endpoint never checks one,
        // so 'none' is the only method actually supported — advertising
        // client_secret_post would invite clients to send a secret we ignore.
        token_endpoint_auth_methods_supported: ['none'],
        registration_endpoint_auth_methods_supported: ['none'],
        scopes_supported: scopes,
        service_documentation: `${baseUrl}/connect`,
    };
}

/** Pending MCP-client authorization: PKCE + client params, bound to a user slot. */
interface PendingAuthorization {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    userId: string;
    expiresAt: number;
    /** The MCP client's own state, echoed back with the code. */
    state?: string;
    /** RFC 8707 resource indicator, validated at authorize, re-checked at exchange. */
    resource?: string;
    /** client_name from DCR, shown on the consent screen so the user knows who is asking. */
    clientName?: string;
}

/** A completed authorization code (single-use, short-lived). */
interface IssuedCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    userId: string;
    expiresAt: number;
    state?: string;
    resource?: string;
}

/** Minimal dynamically-registered client (RFC 7591); DCR without secrets. */
interface RegisteredClient {
    clientId: string;
    redirectUris: string[];
    createdAt: number;
    clientName?: string;
}

/**
 * A redirect URI usable as an OAuth redirection endpoint.
 *
 * A prefix test alone accepts values like "https://" that later throw when
 * constructed — including on the error-redirect path, where the throw would
 * replace the RFC-correct redirect with a 500.
 *
 * Fragments are rejected per RFC 6749 §3.1.2: a registered
 * "https://app.example/cb#main" would otherwise take the authorization code
 * into the fragment and the client would silently never receive it.
 */
function isHttpUrl(value: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.host !== '' &&
        parsed.hash === ''
    );
}

export class McpOauthError extends Error {
    constructor(
        public readonly code: string,
        public readonly status: number,
        public readonly description: string,
        /**
         * True once client_id and redirect_uri are known-good, meaning the error
         * MUST be delivered to the client's redirect_uri (RFC 6749 §4.1.2.1)
         * rather than rendered as JSON in the user's browser.
         */
        public readonly redirectSafe: boolean = false
    ) {
        super(description);
        this.name = 'McpOauthError';
    }
}

/**
 * MCP OAuth authorization server. Pending authorizations and codes live in
 * memory (single-instance deployment, same as sessions); the resume token
 * binding the two flows is HMAC-signed, expiring, and replay-safe.
 */
export class McpOAuthServer {
    private readonly pending = new Map<string, PendingAuthorization>();
    private readonly codes = new Map<string, IssuedCode>();
    private readonly clients = new Map<string, RegisteredClient>();
    private readonly secret: Buffer;
    private readonly scopes: string[];
    private readonly publicBaseUrl: string;

    constructor(
        config: OAuthConfig,
        private readonly authManager: AuthManager,
        publicBaseUrl: string,
        private readonly ttlMs: number = 10 * 60 * 1000
    ) {
        this.secret = createHmac('sha256', 'wrike-mcp-oauth-as').update(config.clientSecret).digest();
        this.scopes = config.scopes;
        this.publicBaseUrl = publicBaseUrl;
    }

    private sign(payload: string): string {
        return createHmac('sha256', this.secret).update(payload).digest('base64url');
    }

    /**
     * Drops expired pending authorizations and codes. Both are only removed on
     * use otherwise, so abandoned flows (user never finishes Wrike consent) and
     * unexchanged codes would accumulate for the life of the process.
     */
    private sweep(): void {
        const now = Date.now();
        for (const [token, p] of this.pending) {
            if (p.expiresAt < now) this.pending.delete(token);
        }
        for (const [code, c] of this.codes) {
            if (c.expiresAt < now) this.codes.delete(code);
        }
    }

    /**
     * RFC 8707 resource indicator check: the audience a client asks for must be
     * this server. Same origin and a path under publicBaseUrl is accepted, so
     * `<base>`, `<base>/` and `<base>/mcp` all pass; anything else is a token
     * meant for a different resource server.
     */
    private resourceMatches(resource: string): boolean {
        let asked: URL;
        let self: URL;
        try {
            asked = new URL(resource);
            self = new URL(this.publicBaseUrl);
        } catch {
            return false;
        }
        if (asked.origin !== self.origin) return false;
        const base = self.pathname.replace(/\/$/, '');
        const path = asked.pathname.replace(/\/$/, '');
        return path === base || path.startsWith(`${base}/`);
    }

    /** PKCE S256 verification (RFC 7636). */
    private verifyPkce(challenge: string, verifier: string): boolean {
        const computed = createHash('sha256').update(verifier).digest('base64url');
        const a = Buffer.from(challenge);
        const b = Buffer.from(computed);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    // ------------------------------------------------------------- discovery

    protectedResourceMetadata(baseUrl: string): object {
        return protectedResourceMetadata(baseUrl);
    }

    authorizationServerMetadata(baseUrl: string): object {
        return authorizationServerMetadata(baseUrl, this.scopes);
    }

    // ----------------------------------------------------- client registration

    /** Dynamic client registration (RFC 7591). Accepts any client_id+redirect_uris. */
    registerClient(body: { client_name?: string; redirect_uris?: string[] }): {
        client_id: string;
        client_id_issued_at: number;
        redirect_uris: string[];
        token_endpoint_auth_method: string;
    } {
        // Public endpoint: a non-array redirect_uris (e.g. a bare JSON string)
        // must be a 400 per RFC 7591, not a TypeError surfacing as server_error.
        const redirectUris = Array.isArray(body.redirect_uris)
            ? body.redirect_uris.filter((u) => typeof u === 'string' && isHttpUrl(u))
            : [];
        if (redirectUris.length === 0) {
            throw new McpOauthError('invalid_redirect_uri', 400, 'redirect_uris must contain at least one http(s) URI');
        }
        const clientId = `mcp_${randomBytes(16).toString('base64url')}`;
        // client_name is display-only and attacker-controlled: it is never
        // trusted for a decision, only shown (HTML-escaped) on the consent
        // screen so the user can judge who is asking.
        const clientName =
            typeof body.client_name === 'string' && body.client_name.trim()
                ? body.client_name.trim().slice(0, 120)
                : undefined;
        this.clients.set(clientId, { clientId, redirectUris, createdAt: Date.now(), clientName });
        this.sweep();
        // Keep the map bounded: drop registrations older than a day, then, if a
        // burst of fresh registrations is still over the cap, evict oldest-first
        // so an open DCR endpoint cannot grow the map without limit.
        if (this.clients.size > 1000) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            for (const [id, c] of this.clients) {
                if (c.createdAt < cutoff) this.clients.delete(id);
            }
            if (this.clients.size > 1000) {
                const oldest = [...this.clients.values()].sort((a, b) => a.createdAt - b.createdAt);
                for (const c of oldest.slice(0, this.clients.size - 1000)) {
                    this.clients.delete(c.clientId);
                }
            }
        }
        return {
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'none',
        };
    }

    /**
     * Display details for a pending authorization, for the consent screen.
     * Does NOT consume the pending entry — the user has not decided yet.
     */
    describePending(
        resumeToken: string
    ): { clientId: string; clientName?: string; redirectUri: string; userId: string } | undefined {
        const pending = this.pending.get(resumeToken);
        if (!pending || pending.expiresAt < Date.now() || !this.verifyResumeToken(resumeToken)) {
            return undefined;
        }
        return {
            clientId: pending.clientId,
            clientName: pending.clientName,
            redirectUri: pending.redirectUri,
            userId: pending.userId,
        };
    }

    /**
     * The registered redirect_uri allow-list for a client, or undefined if the
     * client never registered. beginAuthorization rejects that case outright
     * (invalid_client) — this must stay an allow-list: an unregistered client
     * would otherwise get its own redirect_uri bound to the code and validated
     * against itself at exchange, which is no validation at all.
     */
    private clientRedirectUris(clientId: string): string[] | undefined {
        return this.clients.get(clientId)?.redirectUris;
    }

    // ---------------------------------------------------------- authorization

    /**
     * Validates an MCP client's authorize request and defers to the user's
     * browser: the user completes Wrike OAuth at /connect with a signed
     * "resume" token attached; when Wrike redirects back, the pending
     * authorization turns into a one-time code for the client.
     */
    beginAuthorization(params: {
        clientId: string;
        redirectUri: string;
        codeChallenge?: string;
        codeChallengeMethod?: string;
        state?: string;
        resource?: string;
    }): { redirectUrl: string; resumeToken: string } {
        this.sweep();
        const registered = this.clientRedirectUris(params.clientId);
        // Clients MUST register first (DCR at /oauth/register). The redirect_uri
        // allow-list prevents an attacker from driving a user's consent to an
        // attacker-controlled redirect_uri.
        //
        // These two checks run FIRST and are the only ones thrown without
        // redirectSafe: until the redirect_uri is known-good it must not be
        // redirected to (RFC 6749 §4.1.2.1).
        if (!registered) {
            throw new McpOauthError('invalid_client', 401, 'unknown client_id: register at /oauth/register first');
        }
        if (!registered.includes(params.redirectUri)) {
            throw new McpOauthError('invalid_redirect_uri', 400, 'redirect_uri not registered for this client');
        }
        if (!params.codeChallenge || (params.codeChallengeMethod ?? 'S256') !== 'S256') {
            throw new McpOauthError('invalid_request', 400, 'PKCE (S256) code_challenge is required', true);
        }
        if (params.resource !== undefined && !this.resourceMatches(params.resource)) {
            throw new McpOauthError('invalid_target', 400, 'resource does not identify this server', true);
        }
        const userId = `user-${randomBytes(6).toString('hex')}`;
        const resumeToken = this.issueResumeToken();
        this.pending.set(resumeToken, {
            clientId: params.clientId,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            codeChallengeMethod: 'S256',
            userId,
            expiresAt: Date.now() + this.ttlMs,
            state: params.state,
            resource: params.resource,
            clientName: this.clients.get(params.clientId)?.clientName,
        });
        return {
            // Absolute URL: behind a path-prefixed proxy (handle_path /wrike/*)
            // a relative redirect would drop the prefix and 404 at the proxy.
            redirectUrl: `${this.publicBaseUrl}/connect?user=${encodeURIComponent(userId)}&resume=${encodeURIComponent(resumeToken)}`,
            resumeToken,
        };
    }

    private issueResumeToken(): string {
        const payload = Buffer.from(
            JSON.stringify({ n: randomBytes(16).toString('base64url'), exp: Date.now() + this.ttlMs })
        ).toString('base64url');
        return `${payload}.${this.sign(payload)}`;
    }

    private verifyResumeToken(token: string): boolean {
        const dot = token.lastIndexOf('.');
        if (dot <= 0) return false;
        const payload = token.slice(0, dot);
        const mac = Buffer.from(token.slice(dot + 1));
        const expected = Buffer.from(this.sign(payload));
        if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return false;
        try {
            const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
            return typeof parsed.exp === 'number' && parsed.exp > Date.now();
        } catch {
            return false;
        }
    }

    /**
     * Called when the Wrike /connect flow completes for a user that has a
     * pending MCP authorization: mints a one-time code for the client and
     * returns the client redirect (with state).
     *
     * `userId` is the slot the Wrike tokens were just stored under. /connect
     * takes its handle from the query string, so a crafted URL can pair one
     * user's consent with another authorization's resume token; the code must
     * only be minted when the two agree.
     */
    async completeWrikeAuthorization(
        resumeToken: string,
        userId: string
    ): Promise<{ redirectUrl: string; state?: string } | undefined> {
        this.sweep();
        const pending = this.pending.get(resumeToken);
        if (!pending || pending.expiresAt < Date.now() || !this.verifyResumeToken(resumeToken)) {
            this.pending.delete(resumeToken);
            return undefined;
        }
        this.pending.delete(resumeToken);
        if (pending.userId !== userId) return undefined;
        const code = `mcdc_${randomBytes(32).toString('base64url')}`;
        this.codes.set(code, {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            userId: pending.userId,
            expiresAt: Date.now() + 5 * 60 * 1000,
            state: pending.state,
            resource: pending.resource,
        });
        // Built with the URL API, not string concatenation: concatenation
        // mishandles any redirect_uri that is not a plain path+query.
        const back = new URL(pending.redirectUri);
        back.searchParams.set('code', code);
        if (pending.state) back.searchParams.set('state', pending.state);
        return { redirectUrl: back.toString(), state: pending.state };
    }

    // -------------------------------------------------------------- token

    /**
     * Standard token-endpoint exchange: code + PKCE verifier -> the user's
     * connection token as an OAuth access token (no expiry; no refresh token).
     */
    async exchangeCode(body: {
        grant_type?: string;
        code?: string;
        code_verifier?: string;
        client_id?: string;
        redirect_uri?: string;
        resource?: string;
    }): Promise<{
        access_token: string;
        token_type: string;
        scope: string;
    }> {
        this.sweep();
        if (body.grant_type !== 'authorization_code') {
            throw new McpOauthError('unsupported_grant_type', 400, 'only authorization_code is supported');
        }
        const issued = body.code ? this.codes.get(body.code) : undefined;
        if (!issued || issued.expiresAt < Date.now()) {
            if (body.code) this.codes.delete(body.code);
            throw new McpOauthError('invalid_grant', 400, 'code is invalid or expired');
        }
        if (issued.clientId !== body.client_id) {
            throw new McpOauthError('invalid_grant', 400, 'code was issued to a different client');
        }
        if (issued.redirectUri !== body.redirect_uri) {
            throw new McpOauthError('invalid_grant', 400, 'redirect_uri mismatch');
        }
        if (!body.code_verifier || !this.verifyPkce(issued.codeChallenge, body.code_verifier)) {
            throw new McpOauthError('invalid_grant', 400, 'PKCE verification failed');
        }
        // RFC 8707: the audience asked for at exchange must be the one the code
        // was issued for, and must still identify this server.
        if (body.resource !== undefined && !this.resourceMatches(body.resource)) {
            throw new McpOauthError('invalid_target', 400, 'resource does not identify this server');
        }
        if (issued.resource !== undefined && body.resource !== undefined && issued.resource !== body.resource) {
            throw new McpOauthError('invalid_target', 400, 'resource does not match the authorization request');
        }
        this.codes.delete(body.code!); // single-use
        const connectionToken = await this.authManager.issueConnectionToken(issued.userId);
        return {
            access_token: connectionToken,
            token_type: 'Bearer',
            // expires_in omitted: token does not expire (RFC 6749 — omit rather
            // than 0, which clients may read as instantly expired).
            scope: this.scopes.join(' '),
        };
    }

    /**
     * RFC 7009 revocation, called by the /oauth/revoke-token route. Presenting
     * the token is authorisation to revoke it; an unknown token still returns
     * success per RFC 7009 §2.2, so this never reveals whether a token exists.
     *
     * Each MCP authorization gets its own generated user slot, so revoking the
     * slot revokes exactly this grant.
     */
    async revoke(token: string): Promise<void> {
        const userId = await this.authManager.resolveConnectionToken(token);
        if (userId) await this.authManager.revokeUser(userId);
    }
}