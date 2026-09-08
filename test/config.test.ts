import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const KEY = 'a'.repeat(64);

describe('loadConfig', () => {
    it('builds PAT config from WRIKE_PAT', () => {
        const cfg = loadConfig({ TOKEN_ENCRYPTION_KEY: KEY, WRIKE_PAT: 'perm-token', WRIKE_HOST: 'app-us2.wrike.com' });
        expect(cfg.auth).toEqual({ mode: 'pat', pat: 'perm-token', host: 'app-us2.wrike.com' });
        expect(cfg.tokenEncryptionKey.length).toBe(32);
    });

    it('builds OAuth config from client credentials', () => {
        const cfg = loadConfig({
            TOKEN_ENCRYPTION_KEY: KEY,
            WRIKE_CLIENT_ID: 'cid',
            WRIKE_CLIENT_SECRET: 'sec',
            WRIKE_REDIRECT_URI: 'https://example.com/oauth/callback',
            WRIKE_SCOPES: 'Default,wsReadWrite',
        });
        expect(cfg.auth).toEqual({
            mode: 'oauth',
            clientId: 'cid',
            clientSecret: 'sec',
            redirectUri: 'https://example.com/oauth/callback',
            scopes: ['Default', 'wsReadWrite'],
        });
    });

    it('rejects oauth mode without redirect URI', () => {
        expect(() =>
            loadConfig({ TOKEN_ENCRYPTION_KEY: KEY, AUTH_MODE: 'oauth', WRIKE_CLIENT_ID: 'cid', WRIKE_CLIENT_SECRET: 's' })
        ).toThrow(ConfigError);
    });

    it('rejects missing encryption key', () => {
        expect(() => loadConfig({ WRIKE_PAT: 'x' })).toThrow(ConfigError);
    });

    it('rejects a malformed encryption key', () => {
        expect(() => loadConfig({ TOKEN_ENCRYPTION_KEY: 'zz', WRIKE_PAT: 'x' })).toThrow(ConfigError);
    });

    it('fails when no auth method is configured', () => {
        expect(() => loadConfig({ TOKEN_ENCRYPTION_KEY: KEY })).toThrow(/No authentication configured/);
    });

    it('explicit AUTH_MODE=pat ignores oauth vars', () => {
        const cfg = loadConfig({
            TOKEN_ENCRYPTION_KEY: KEY,
            AUTH_MODE: 'pat',
            WRIKE_PAT: 't',
            WRIKE_CLIENT_ID: 'ignored',
        });
        expect(cfg.auth.mode).toBe('pat');
    });
});