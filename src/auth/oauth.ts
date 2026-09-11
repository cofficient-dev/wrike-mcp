import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { OAuthConfig } from '../config.js';

export const WRIKE_AUTHORIZE_URL = 'https://login.wrike.com/oauth2/authorize/v4';
export const WRIKE_TOKEN_URL = 'https://login.wrike.com/oauth2/token';

export interface OAuthTokenResponse {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    host?: string;
}

export interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    expiresAtMs: number;
    host: string;
}

/**
 * HMAC-signed, expiring OAuth `state` values.
 * Format: base64url(payload).base64url(hmac)
 * payload = {nonce, exp, pendingUserId?} — protects the callback against
 * CSRF and replay, and binds a /connect session to the pending user slot.
 */
export class OAuthStateManager {
    private readonly secret: Buffer;
    private readonly ttlMs: number;

    constructor(clientSecret: string, ttlMs = 10 * 60 * 1000) {
        this.secret = createHmac('sha256', 'wrike-mcp-state').update(clientSecret).digest();
        this.ttlMs = ttlMs;
    }

    private sign(payload: string): string {
        return createHmac('sha256', this.secret).update(payload).digest('base64url');
    }

    /** Issues a state value; optionally binds it to a pending per-user connection. */
    issue(pendingUserId?: string, pendingResume?: string): string {
        const payload = Buffer.from(
            JSON.stringify({
                nonce: randomBytes(16).toString('base64url'),
                exp: Date.now() + this.ttlMs,
                ...(pendingUserId !== undefined ? { u: pendingUserId } : {}),
                ...(pendingResume !== undefined ? { r: pendingResume } : {}),
            })
        ).toString('base64url');
        return `${payload}.${this.sign(payload)}`;
    }

    /** Verifies signature and expiry; returns the bound pending user ID if present. */
    verify(state: string): { valid: boolean; pendingUserId?: string; pendingResume?: string } {
        const dot = state.lastIndexOf('.');
        if (dot <= 0) return { valid: false };
        const payload = state.slice(0, dot);
        const mac = Buffer.from(state.slice(dot + 1));
        const expected = Buffer.from(this.sign(payload));
        if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return { valid: false };
        try {
            const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
                nonce?: unknown;
                exp?: unknown;
                u?: unknown;
                r?: unknown;
            };
            if (typeof parsed.exp !== 'number' || parsed.exp <= Date.now() || typeof parsed.nonce !== 'string') {
                return { valid: false };
            }
            return {
                valid: true,
                pendingUserId: typeof parsed.u === 'string' ? parsed.u : undefined,
                pendingResume: typeof parsed.r === 'string' ? parsed.r : undefined,
            };
        } catch {
            return { valid: false };
        }
    }
}

/**
 * Exchanges an authorization code for tokens.
 * Token exchange happens server-side only; the client secret never leaves the process.
 */
export async function exchangeCodeForTokens(
    config: OAuthConfig,
    code: string,
    fetchImpl: typeof fetch = fetch
): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
    });
    const res = await fetchImpl(WRIKE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        throw new Error(`Wrike token exchange failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as OAuthTokenResponse;
    if (!json.access_token) {
        throw new Error('Wrike token exchange response missing access_token');
    }
    return json;
}

export async function refreshTokens(
    config: OAuthConfig,
    refreshToken: string,
    fetchImpl: typeof fetch = fetch
): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    });
    if (config.scopes.length > 0) body.set('scope', config.scopes.join(','));
    const res = await fetchImpl(WRIKE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        throw new Error(`Wrike token refresh failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as OAuthTokenResponse;
    if (!json.access_token) {
        throw new Error('Wrike token refresh response missing access_token');
    }
    return json;
}

export function toStoredTokens(resp: OAuthTokenResponse, fallbackHost: string): StoredTokens {
    return {
        accessToken: resp.access_token,
        refreshToken: resp.refresh_token ?? '',
        expiresAtMs: Date.now() + resp.expires_in * 1000,
        host: resp.host ?? fallbackHost,
    };
}