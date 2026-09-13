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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const rateLimited = () => jsonResponse(429, { error: 'rate_limited', errorDescription: 'Too many requests' }, { 'Retry-After': '0' });

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

  it('throws on non-2xx without leaking the secret, and does not retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));
    await expect(exchangeCodeForTokens(config, 'bad', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 400/
    );
    expect(String(fetchImpl.mock.calls[0])).not.toContain('csec');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'AT', refresh_token: 'RT', token_type: 'bearer', expires_in: 3600 })
      );
    const resp = await exchangeCodeForTokens(config, 'auth-code', fetchImpl as unknown as typeof fetch);
    expect(resp.access_token).toBe('AT');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds 429 retries and surfaces Wrike error and errorDescription', async () => {
    // A fresh Response per call: reusing one instance across calls would have
    // its body cancelled by an earlier (retried) attempt, leaving nothing for
    // the final attempt to read.
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(rateLimited()));
    await expect(exchangeCodeForTokens(config, 'auth-code', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 429 \(rate_limited\): Too many requests/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('cancels the retried 429 response body instead of leaving it unread', async () => {
    const failed = rateLimited();
    const cancelSpy = vi.spyOn(failed.body!, 'cancel');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'AT', refresh_token: 'RT', token_type: 'bearer', expires_in: 3600 })
      );
    await exchangeCodeForTokens(config, 'auth-code', fetchImpl as unknown as typeof fetch);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
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

  it('retries once on 429 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'AT2', refresh_token: 'RT2', token_type: 'bearer', expires_in: 3600 })
      );
    const resp = await refreshTokens(config, 'RT', fetchImpl as unknown as typeof fetch);
    expect(resp.access_token).toBe('AT2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds 429 retries and surfaces Wrike error and errorDescription', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(rateLimited()));
    await expect(refreshTokens(config, 'RT', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 429 \(rate_limited\): Too many requests/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});