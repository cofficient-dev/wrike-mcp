import { describe, it, expect, vi } from 'vitest';
import { AuthManager } from '../src/auth/authManager.js';
import { EncryptedTokenStore } from '../src/secrets/tokenStore.js';
import type { PatConfig, OAuthConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const key = randomBytes(32);
function makeStore(): { store: EncryptedTokenStore; dir: string } {
  const dir = join(tmpdir(), `authmgr-${randomBytes(6).toString('hex')}`);
  return { store: new EncryptedTokenStore(key, join(dir, 'tokens.json')), dir };
}

const patConfig: PatConfig = { mode: 'pat', pat: 'the-pat', host: 'www.wrike.com' };
const oauthConfig: OAuthConfig = {
  mode: 'oauth',
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: 'https://example.com/cb',
  scopes: ['Default'],
};

const tokens = (over: Partial<{ at: string; rt: string; host: string; expiresIn: number }> = {}) => ({
  accessToken: over.at ?? 'AT',
  refreshToken: over.rt ?? 'RT',
  expiresAtMs: over.expiresIn !== undefined ? over.expiresIn : Date.now() + 3600_000,
  host: over.host ?? 'www.wrike.com',
});

describe('AuthManager PAT mode', () => {
  it('always has credentials for the single PAT user and returns the PAT', async () => {
    const { store } = makeStore();
    const mgr = new AuthManager(patConfig, store);
    expect(await mgr.hasCredentials('__pat__')).toBe(true);
    expect(await mgr.getAccessToken('__pat__')).toBe('the-pat');
    expect(await mgr.getHost('__pat__')).toBe('www.wrike.com');
    expect(await mgr.listUsers()).toEqual(['__pat__']);
  });

  it('refresh is an error in pat mode', async () => {
    const { store } = makeStore();
    const mgr = new AuthManager(patConfig, store);
    await expect(mgr.refresh('__pat__')).rejects.toThrow(/oauth/);
  });
});

describe('AuthManager OAuth mode — per-user', () => {
  it('serves each user their own tokens and host (US vs EU data centers)', async () => {
    const { store } = makeStore();
    const mgr = new AuthManager(oauthConfig, store);
    await mgr.storeUserTokens('alice', tokens({ at: 'AT-ALICE', host: 'app-us2.wrike.com' }));
    await mgr.storeUserTokens('bob', tokens({ at: 'AT-BOB', host: 'app-eu.wrike.com' }));

    expect(await mgr.getAccessToken('alice')).toBe('AT-ALICE');
    expect(await mgr.getAccessToken('bob')).toBe('AT-BOB');
    expect(await mgr.getHost('alice')).toBe('app-us2.wrike.com');
    expect(await mgr.getHost('bob')).toBe('app-eu.wrike.com');
    expect((await mgr.listUsers()).sort()).toEqual(['alice', 'bob']);
  });

  it('unknown users are reported as needing authorization', async () => {
    const { store } = makeStore();
    const mgr = new AuthManager(oauthConfig, store);
    expect(await mgr.getStatus('nobody')).toBe('needs_authorization');
    await expect(mgr.getAccessToken('nobody')).rejects.toThrow(/\/connect/);
  });

  it('persists users across manager restarts (encrypted store)', async () => {
    const { store } = makeStore();
    const mgr1 = new AuthManager(oauthConfig, store);
    await mgr1.storeUserTokens('alice', tokens({ at: 'AT-ALICE' }));
    const mgr2 = new AuthManager(oauthConfig, store);
    expect(await mgr2.getAccessToken('alice')).toBe('AT-ALICE');
  });

  it('issues a connection token that resolves to the right user only', async () => {
    const { store } = makeStore();
    const mgr = new AuthManager(oauthConfig, store);
    await mgr.storeUserTokens('alice', tokens());
    await mgr.storeUserTokens('bob', tokens());
    const ct = await mgr.issueConnectionToken('alice');
    expect(ct).toMatch(/^wmc_/);
    expect(await mgr.resolveConnectionToken(ct)).toBe('alice');
    expect(await mgr.resolveConnectionToken('wmc_forged')).toBeUndefined();
    // The plaintext never persists on disk.
    const raw = (await store.read())!;
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(ct);
  });

  it('revoking a user removes only that user', async () => {
    const { store } = makeStore();
    const mgr = new AuthManager(oauthConfig, store);
    await mgr.storeUserTokens('alice', tokens());
    await mgr.storeUserTokens('bob', tokens());
    const ctBob = await mgr.issueConnectionToken('bob');
    await mgr.revokeUser('alice');
    expect(await mgr.hasCredentials('alice')).toBe(false);
    expect(await mgr.getAccessToken('bob')).toBe('AT');
    expect(await mgr.resolveConnectionToken(ctBob)).toBe('bob');
  });

  it('refreshes a user near expiry and persists the new tokens', async () => {
    const { store } = makeStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'AT2', refresh_token: 'RT2', token_type: 'bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const mgr = new AuthManager(oauthConfig, store, () => 1_000_000, fetchImpl as unknown as typeof fetch);
    await mgr.storeUserTokens('alice', { accessToken: 'AT1', refreshToken: 'RT1', expiresAtMs: 999_000, host: 'h' });
    expect(await mgr.getAccessToken('alice')).toBe('AT2');
    const reloaded = new AuthManager(oauthConfig, store, () => 1_000_000);
    await expect(reloaded.getAccessToken('alice')).resolves.toBe('AT2');
  });

  it('collapses concurrent refreshes for the same user into one call (single-flight)', async () => {
    const { store } = makeStore();
    let resolveRefresh!: (v: Response) => void;
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => { resolveRefresh = resolve; })
    );
    const mgr = new AuthManager(oauthConfig, store, () => 0, fetchImpl as unknown as typeof fetch);
    await mgr.storeUserTokens('alice', { accessToken: 'A', refreshToken: 'R', expiresAtMs: -1, host: 'h' });

    const p1 = mgr.refresh('alice');
    const p2 = mgr.refresh('alice');
    await vi.waitFor(() => {
      if (fetchImpl.mock.calls.length === 0) throw new Error('not yet');
    });
    resolveRefresh(
      new Response(JSON.stringify({ access_token: 'X', refresh_token: 'Y', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
    expect(r1.accessToken).toBe('X');
  });

  it('refreshes different users independently (no cross-user blocking)', async () => {
    const { store } = makeStore();
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'NR', token_type: 'bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const mgr = new AuthManager(oauthConfig, store, () => 0, fetchImpl as unknown as typeof fetch);
    await mgr.storeUserTokens('alice', { accessToken: 'A', refreshToken: 'RA', expiresAtMs: -1, host: 'h' });
    await mgr.storeUserTokens('bob', { accessToken: 'B', refreshToken: 'RB', expiresAtMs: -1, host: 'h' });
    await Promise.all([mgr.refresh('alice'), mgr.refresh('bob')]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});