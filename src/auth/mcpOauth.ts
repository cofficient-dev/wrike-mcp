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
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
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
}

/** A completed authorization code (single-use, short-lived). */
interface IssuedCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    userId: string;
    expiresAt: number;
    state?: string;
}

/** Minimal dynamically-registered client (RFC 7591); DCR without secrets. */
interface RegisteredClient {
    clientId: string;
    redirectUris: string[];
    createdAt: number;
}

export class McpOauthError extends Error {
    constructor(
        public readonly code: string,
        public readonly status: number,
        public readonly description: string
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

    constructor(
        config: OAuthConfig,
        private readonly authManager: AuthManager,
        private readonly ttlMs: number = 10 * 60 * 1000
    ) {
        this.secret = createHmac('sha256', 'wrike-mcp-oauth-as').update(config.clientSecret).digest();
        this.scopes = config.scopes;
    }

    private sign(payload: string): string {
        return createHmac('sha256', this.secret).update(payload).digest('base64url');
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
        const redirectUris = (body.redirect_uris ?? []).filter(
            (u) => typeof u === 'string' && /^https?:\/\//.test(u)
        );
        if (redirectUris.length === 0) {
            throw new McpOauthError('invalid_redirect_uri', 400, 'redirect_uris must contain at least one http(s) URI');
        }
        const clientId = `mcp_${randomBytes(16).toString('base64url')}`;
        this.clients.set(clientId, { clientId, redirectUris, createdAt: Date.now() });
        // Keep the map bounded: drop registrations older than a day.
        if (this.clients.size > 1000) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            for (const [id, c] of this.clients) {
                if (c.createdAt < cutoff) this.clients.delete(id);
            }
        }
        return {
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'none',
        };
    }

    private clientRedirectUris(clientId: string): string[] | undefined {
        // Clients that did not register (CIMD/custom client IDs) are accepted;
        // their redirect_uri is validated by exact-match at exchange time.
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
        const registered = this.clientRedirectUris(params.clientId);
        if (registered && !registered.includes(params.redirectUri)) {
            throw new McpOauthError('invalid_redirect_uri', 400, 'redirect_uri not registered for this client');
        }
        if (!params.codeChallenge || (params.codeChallengeMethod ?? 'S256') !== 'S256') {
            throw new McpOauthError('invalid_request', 400, 'PKCE (S256) code_challenge is required');
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
        });
        return {
            redirectUrl: `/connect?user=${encodeURIComponent(userId)}&resume=${encodeURIComponent(resumeToken)}`,
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
     */
    async completeWrikeAuthorization(
        resumeToken: string
    ): Promise<{ redirectUrl: string; state?: string } | undefined> {
        const pending = this.pending.get(resumeToken);
        if (!pending || pending.expiresAt < Date.now() || !this.verifyResumeToken(resumeToken)) {
            this.pending.delete(resumeToken);
            return undefined;
        }
        this.pending.delete(resumeToken);
        const code = `mcdc_${randomBytes(32).toString('base64url')}`;
        this.codes.set(code, {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            userId: pending.userId,
            expiresAt: Date.now() + 5 * 60 * 1000,
            state: pending.state,
        });
        const q = new URLSearchParams({ code });
        if (pending.state) q.set('state', pending.state);
        return {
            redirectUrl: `${pending.redirectUri}${pending.redirectUri.includes('?') ? '&' : '?'}${q.toString()}`,
            state: pending.state,
        };
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
    }): Promise<{
        access_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
    }> {
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
        this.codes.delete(body.code!); // single-use
        const connectionToken = await this.authManager.issueConnectionToken(issued.userId);
        return {
            access_token: connectionToken,
            token_type: 'Bearer',
            expires_in: 0, // does not expire; users revoke at /revoke
            scope: this.scopes.join(' '),
        };
    }

    /**
     * RFC 7009-style revocation for MCP clients (best-effort): revoking an
     * unknown token still returns 200 per RFC 7009. Tokens are revoked only
     * by their user at POST /revoke — deliberate no-op.
     */
    async revoke(_token: string): Promise<void> {
        /* no-op by design */
    }
}