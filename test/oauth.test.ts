import { describe, it, expect, vi } from 'vitest';
import { OAuthStateManager, exchangeCodeForTokens, refreshTokens } from '../src/auth/oauth.js';
import type { OAuthConfig } from '../src/config.js';

describe('OAuthStateManager', () => {
  const manager = new OAuthStateManager('client-secret');

  it('issues and verifies a fresh state', () => {
    const state = manager.issue();
    expect(manager.verify(state)).toEqual({ valid: true, pendingUserId: undefined });
  });

  it('binds a pending user handle into the state', () => {
    const state = manager.issue('alice');
    expect(manager.verify(state)).toEqual({ valid: true, pendingUserId: 'alice' });
  });

  it('rejects a forged state', () => {
    const state = manager.issue();
    expect(manager.verify(`${state}x`).valid).toBe(false);
    expect(manager.verify('not-a-state').valid).toBe(false);
    expect(manager.verify('a.b').valid).toBe(false);
    expect(manager.verify('').valid).toBe(false);
  });

  it('rejects a state signed with a different secret', () => {
    const other = new OAuthStateManager('different-secret');
    const state = other.issue();
    expect(manager.verify(state).valid).toBe(false);
  });

  it('rejects an expired state', () => {
    const shortTtl = new OAuthStateManager('client-secret', -1000);
    const state = shortTtl.issue();
    expect(shortTtl.verify(state).valid).toBe(false);
  });
});

const config: OAuthConfig = {
  mode: 'oauth',
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: 'https://example.com/cb',
  scopes: ['Default'],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('exchangeCodeForTokens', () => {
  it('posts the authorization_code grant and parses the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: 'AT', refresh_token: 'RT', token_type: 'bearer', expires_in: 3600, host: 'www.wrike.com' })
    );
    const resp = await exchangeCodeForTokens(config, 'auth-code', fetchImpl as unknown as typeof fetch);
    expect(resp.access_token).toBe('AT');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = (init.body as URLSearchParams).toString();
    expect(url).toBe('https://login.wrike.com/oauth2/token');
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=csec');
    expect(body).toContain('redirect_uri=');
  });

  it('throws on non-2xx without leaking the secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));
    await expect(exchangeCodeForTokens(config, 'bad', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 400/
    );
    expect(String(fetchImpl.mock.calls[0])).not.toContain('csec');
  });
});

describe('refreshTokens', () => {
  it('posts the refresh_token grant with scopes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: 'AT2', refresh_token: 'RT2', token_type: 'bearer', expires_in: 3600 })
    );
    const resp = await refreshTokens(config, 'RT', fetchImpl as unknown as typeof fetch);
    expect(resp.access_token).toBe('AT2');
    const body = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.toString()).toContain('grant_type=refresh_token');
    expect(body.toString()).toContain('refresh_token=RT');
    expect(body.toString()).toContain('scope=Default');
  });
});