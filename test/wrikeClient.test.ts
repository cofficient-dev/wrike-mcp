import { describe, it, expect, vi } from 'vitest';
import { WrikeClient, WrikeApiError } from '../src/wrikeClient.js';
import { AuthManager } from '../src/auth/authManager.js';
import { EncryptedTokenStore } from '../src/secrets/tokenStore.js';
import type { OAuthConfig, PatConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const key = randomBytes(32);
const dir = join(tmpdir(), `client-test-${randomBytes(4).toString('hex')}`);
const store = new EncryptedTokenStore(key, join(dir, 'tokens.json'));

const patConfig: PatConfig = { mode: 'pat', pat: 'PAT-TOKEN', host: 'www.wrike.com' };
const oauthConfig: OAuthConfig = {
  mode: 'oauth',
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: 'https://example.com/cb',
  scopes: ['Default'],
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const tokens = (over: Partial<{ at: string; host: string; expiresIn: number }> = {}) => ({
  accessToken: over.at ?? 'AT',
  refreshToken: 'RT',
  expiresAtMs: over.expiresIn !== undefined ? over.expiresIn : Date.now() + 3600_000,
  host: over.host ?? 'www.wrike.com',
});

describe('WrikeClient (per-user)', () => {
  it('sends the user bearer auth, unwraps {kind,data}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { kind: 'contacts', data: [{ id: 'KUAJ25LC', me: true }] })
    );
    const client = new WrikeClient(new AuthManager(patConfig, store), '__pat__', fetchImpl as unknown as typeof fetch);
    const res = await client.get('/contacts', { me: 'true' });
    expect(res.kind).toBe('contacts');
    expect(res.data).toEqual([{ id: 'KUAJ25LC', me: true }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.wrike.com/api/v4/contacts?me=true');
    expect((init.headers as Record<string, string>).Authorization).toBe('bearer PAT-TOKEN');
  });

  it('maps Wrike error responses to WrikeApiError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, { error: 'wrong_parameter', errorDescription: 'Invalid folder ID' })
    );
    const client = new WrikeClient(new AuthManager(patConfig, store), '__pat__', fetchImpl as unknown as typeof fetch);
    await expect(client.get('/tasks')).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(WrikeApiError);
      const err = e as WrikeApiError;
      expect(err.status).toBe(400);
      expect(err.code).toBe('wrong_parameter');
      expect(err.message).toContain('Invalid folder ID');
      return true;
    });
  });

  it('uses each user own tokens and data-center host', async () => {
    const mgr = new AuthManager(oauthConfig, store);
    await mgr.storeUserTokens('alice', tokens({ at: 'AT-ALICE', host: 'app-us2.wrike.com' }));
    await mgr.storeUserTokens('bob', tokens({ at: 'AT-BOB', host: 'app-eu.wrike.com' }));

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { kind: 'tasks', data: [] }));
    const aliceClient = new WrikeClient(mgr, 'alice', fetchImpl as unknown as typeof fetch);
    await aliceClient.get('/tasks');
    const [urlA, initA] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(urlA).toContain('https://app-us2.wrike.com/api/v4/tasks');
    expect((initA.headers as Record<string, string>).Authorization).toBe('bearer AT-ALICE');

    await new WrikeClient(mgr, 'bob', fetchImpl as unknown as typeof fetch).get('/tasks');
    const [urlB, initB] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(urlB).toContain('https://app-eu.wrike.com/api/v4/tasks');
    expect((initB.headers as Record<string, string>).Authorization).toBe('bearer AT-BOB');
  });

  it('refreshes and retries once on 401 for that user', async () => {
    let first = true;
    const refreshFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: 'AT2', refresh_token: 'RT2', token_type: 'bearer', expires_in: 3600 })
    );
    const fetchImpl = vi.fn().mockImplementation(() => {
      if (first) {
        first = false;
        return Promise.resolve(jsonResponse(401, { error: 'not_authorized', errorDescription: 'Access token is unknown or invalid' }));
      }
      return Promise.resolve(jsonResponse(200, { kind: 'tasks', data: [] }));
    });
    const mgr = new AuthManager(oauthConfig, store, Date.now, refreshFetch as unknown as typeof fetch);
    await mgr.storeUserTokens('alice', tokens());
    const client = new WrikeClient(mgr, 'alice', fetchImpl as unknown as typeof fetch);
    const res = await client.request('GET', '/tasks'); // 401 -> refresh -> retry
    expect(res.kind).toBe('tasks');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT refresh on 401 in pat mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'not_authorized', errorDescription: 'x' }));
    const client = new WrikeClient(new AuthManager(patConfig, store), '__pat__', fetchImpl as unknown as typeof fetch);
    await expect(client.get('/tasks')).rejects.toBeInstanceOf(WrikeApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and honors Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate_limit_exceeded' }, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { kind: 'tasks', data: [] }));
    const client = new WrikeClient(new AuthManager(patConfig, store), '__pat__', fetchImpl as unknown as typeof fetch);
    const res = await client.get('/tasks');
    expect(res.kind).toBe('tasks');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails after exhausting 429 retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(429, { error: 'rate_limit_exceeded' }, { 'Retry-After': '0' })
    );
    const client = new WrikeClient(new AuthManager(patConfig, store), '__pat__', fetchImpl as unknown as typeof fetch);
    await expect(client.get('/tasks')).rejects.toBeInstanceOf(WrikeApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('upload posts multipart with the user auth header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { kind: 'attachments', data: [{ id: 'A' }] }));
    const client = new WrikeClient(new AuthManager(patConfig, store), '__pat__', fetchImpl as unknown as typeof fetch);
    const res = await client.upload('/tasks/TASK1234/attachments', {
      name: 'file.txt',
      contentType: 'text/plain',
      data: Buffer.from('hello'),
    });
    expect(res.kind).toBe('attachments');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/tasks/TASK1234/attachments');
    expect((init.headers as Record<string, string>).Authorization).toBe('bearer PAT-TOKEN');
    expect(init.body).toBeInstanceOf(FormData);
  });
});