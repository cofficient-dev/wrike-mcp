import express from 'express';
import { z } from 'zod';

const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)');

/**
 * MCP-client redirect URIs accepted at dynamic client registration. Claude
 * web/desktop use these; Claude Code and other local clients use a loopback
 * URI on any port (allowed separately).
 */
export const DEFAULT_REDIRECT_ALLOWLIST = [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
];

const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('127.0.0.1'),
    AUTH_MODE: z.enum(['pat', 'oauth']).optional(),
    WRIKE_PAT: z.string().min(1).optional(),
    WRIKE_HOST: z.string().min(1).optional(),
    WRIKE_CLIENT_ID: z.string().min(1).optional(),
    WRIKE_CLIENT_SECRET: z.string().min(1).optional(),
    WRIKE_REDIRECT_URI: z.string().url().optional(),
    WRIKE_SCOPES: z.string().optional(),
    TOKEN_ENCRYPTION_KEY: hex64,
    TOKEN_STORE_PATH: z.string().default('data/tokens.json'),
    PUBLIC_BASE_URL: z.string().url().optional(),
    MCP_REDIRECT_URI_ALLOWLIST: z.string().optional(),
    MCP_ALLOW_LOOPBACK_REDIRECTS: z.enum(['true', 'false']).default('true'),
    TRUST_PROXY: z.string().min(1).default('loopback, uniquelocal'),
});

export interface PatConfig {
    mode: 'pat';
    pat: string;
    host: string;
}

export interface OAuthConfig {
    mode: 'oauth';
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
}

export type AuthConfig = PatConfig | OAuthConfig;

export interface AppConfig {
    port: number;
    host: string;
    auth: AuthConfig;
    tokenEncryptionKey: Buffer;
    tokenStorePath: string;
    /** Public origin (scheme+host[+path prefix]) used in OAuth metadata, e.g. https://host/wrike */
    publicBaseUrl?: string;
    /** Exact redirect URIs accepted at DCR; defaults to DEFAULT_REDIRECT_ALLOWLIST. */
    redirectUriAllowlist?: string[];
    /** Also accept http://localhost / 127.0.0.1 / [::1] on any port at DCR; defaults to true. */
    allowLoopbackRedirects?: boolean;
    /** Express `trust proxy`: IPs/CIDRs or proxy-addr keywords (loopback, linklocal, uniquelocal); false = trust none. Defaults to 'loopback, uniquelocal'. */
    trustProxy?: string | false;
}

export class ConfigError extends Error { }

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new ConfigError(`Invalid configuration: ${issues}`);
    }
    const e = parsed.data;

    let auth: AuthConfig | undefined;
    const mode = e.AUTH_MODE ?? (e.WRIKE_PAT ? 'pat' : e.WRIKE_CLIENT_ID ? 'oauth' : undefined);

    if (mode === 'pat') {
        if (!e.WRIKE_PAT) throw new ConfigError('AUTH_MODE=pat requires WRIKE_PAT');
        auth = { mode: 'pat', pat: e.WRIKE_PAT, host: e.WRIKE_HOST ?? 'www.wrike.com' };
    } else if (mode === 'oauth') {
        const missing = (['WRIKE_CLIENT_ID', 'WRIKE_CLIENT_SECRET', 'WRIKE_REDIRECT_URI'] as const).filter(
            (k) => !e[k]
        );
        if (missing.length > 0) {
            throw new ConfigError(`AUTH_MODE=oauth requires ${missing.join(', ')}`);
        }
        auth = {
            mode: 'oauth',
            clientId: e.WRIKE_CLIENT_ID!,
            clientSecret: e.WRIKE_CLIENT_SECRET!,
            redirectUri: e.WRIKE_REDIRECT_URI!,
            scopes: (e.WRIKE_SCOPES ?? 'Default').split(',').map((s) => s.trim()).filter(Boolean),
        };
    } else {
        throw new ConfigError(
            'No authentication configured: set WRIKE_PAT (pat mode) or WRIKE_CLIENT_ID/WRIKE_CLIENT_SECRET/WRIKE_REDIRECT_URI (oauth mode)'
        );
    }

    // 'none' disables proxy trust (direct exposure). Anything else must be IPs/CIDRs or
    // proxy-addr keywords; hostnames are not resolved. Compile it now so a bad value fails
    // at startup with a clear message instead of a cryptic error when the app is built.
    const trustProxy: string | false = e.TRUST_PROXY.trim().toLowerCase() === 'none' ? false : e.TRUST_PROXY;
    if (trustProxy !== false) {
        try {
            express().set('trust proxy', trustProxy);
        } catch {
            throw new ConfigError(
                `Invalid configuration: TRUST_PROXY must be 'none' or comma-separated IPs/CIDRs or loopback/linklocal/uniquelocal (hostnames are not resolved); got ${JSON.stringify(e.TRUST_PROXY)}`
            );
        }
    }

    return {
        port: e.PORT,
        host: e.HOST,
        auth,
        tokenEncryptionKey: Buffer.from(e.TOKEN_ENCRYPTION_KEY, 'hex'),
        tokenStorePath: e.TOKEN_STORE_PATH,
        publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/$/, ''),
        redirectUriAllowlist: e.MCP_REDIRECT_URI_ALLOWLIST
            ? e.MCP_REDIRECT_URI_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
            : DEFAULT_REDIRECT_ALLOWLIST,
        allowLoopbackRedirects: e.MCP_ALLOW_LOOPBACK_REDIRECTS === 'true',
        trustProxy,
    };
}