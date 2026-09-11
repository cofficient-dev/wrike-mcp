import { describe, it, expect, vi } from 'vitest';
import { WrikeClient, WrikeApiError, BinaryTooLargeError } from '../src/wrikeClient.js';
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
describe('WrikeClient.getBinary', () => {
  it('returns raw bytes, content type and filename', async () => {
    const manager = new AuthManager(patConfig, store);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': 'attachment; filename="Image-2025.png"',
        },
      })
    );
    const client = new WrikeClient(manager, AuthManager.PAT_USER_ID, fetchImpl as unknown as typeof fetch);

    const out = await client.getBinary('/attachments/IEAGIITRIMFWG6YH/download');
    expect(out.data.equals(bytes)).toBe(true);
    expect(out.contentType).toBe('image/png');
    expect(out.filename).toBe('Image-2025.png');
    // Binary body must not be parsed as JSON — that was the reason download
    // could not be supported through the normal request path.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://www.wrike.com/api/v4/attachments/IEAGIITRIMFWG6YH/download');
    expect((init.headers as Record<string, string>).Authorization).toBe('bearer PAT-TOKEN');
  });

  it('surfaces a JSON error body as WrikeApiError', async () => {
    const manager = new AuthManager(patConfig, store);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: 'not_found', errorDescription: 'Attachment not found' }));
    const client = new WrikeClient(manager, AuthManager.PAT_USER_ID, fetchImpl as unknown as typeof fetch);

    await expect(client.getBinary('/attachments/IEAGIITRIMFWG6YH/download')).rejects.toThrow(WrikeApiError);
  });

  it('refreshes once on 401 and retries', async () => {
    // Token refresh goes through the AuthManager's own fetch, not the client's.
    const refreshFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: 'AT2', refresh_token: 'RT2', token_type: 'bearer', expires_in: 3600 })
    );
    let first = true;
    const fetchImpl = vi.fn().mockImplementation(() => {
      if (first) {
        first = false;
        return Promise.resolve(jsonResponse(401, { error: 'not_authorized', errorDescription: 'stale' }));
      }
      return Promise.resolve(new Response(new Uint8Array(Buffer.from('OK')), { status: 200 }));
    });
    const mgr = new AuthManager(oauthConfig, store, Date.now, refreshFetch as unknown as typeof fetch);
    await mgr.storeUserTokens('dl-user', tokens());
    const client = new WrikeClient(mgr, 'dl-user', fetchImpl as unknown as typeof fetch);

    const out = await client.getBinary('/attachments/IEAGIITRIMFWG6YH/download');
    expect(out.data.toString()).toBe('OK');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
  });
});

describe('WrikeClient.getBinary size limit', () => {
  it('rejects on Content-Length without draining the body', async () => {
    const manager = new AuthManager(patConfig, store);
    // An effectively unbounded body: pull() never closes the stream. A
    // ReadableStream source is allowed to call pull() once on its own, to
    // prime its internal queue, regardless of whether anything reads from
    // it — that is normal WHATWG streams behavior, not something this test
    // should assert against. What must not happen is draining this stream
    // to find its end, which is what proves the Content-Length check ran
    // instead of falling through to the streamed reader loop.
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(6 * 1024 * 1024) },
      })
    );
    const client = new WrikeClient(manager, AuthManager.PAT_USER_ID, fetchImpl as unknown as typeof fetch);

    await expect(
      client.getBinary('/attachments/IEAGIITRIMFWG6YH/download', {}, 0, 5 * 1024 * 1024)
    ).rejects.toThrow(BinaryTooLargeError);
    // A stream with no queuing strategy override buffers only a handful of
    // chunks ahead of the reader on its own; reading it to find the (never
    // arriving) end would pull far more than that.
    expect(pullCount).toBeLessThan(5);
  });

  it('aborts a chunked (no Content-Length) body once the streamed budget is exceeded', async () => {
    const manager = new AuthManager(patConfig, store);
    let chunksSent = 0;
    const chunkSize = 1024 * 1024; // 1MB per chunk, 5MB budget below
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent += 1;
        controller.enqueue(new Uint8Array(chunkSize));
        // An unbounded/lying server: never signals done on its own.
        if (chunksSent > 8) controller.close();
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
    );
    const client = new WrikeClient(manager, AuthManager.PAT_USER_ID, fetchImpl as unknown as typeof fetch);

    await expect(
      client.getBinary('/attachments/IEAGIITRIMFWG6YH/download', {}, 0, 5 * chunkSize)
    ).rejects.toThrow(BinaryTooLargeError);
    // Must not have been made to read every chunk of an 8MB+ body to notice
    // it exceeded a 5MB budget.
    expect(chunksSent).toBeLessThan(8);
  });

  it('succeeds when the body is under the budget', async () => {
    const manager = new AuthManager(patConfig, store);
    const bytes = Buffer.from('small file');
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );
    const client = new WrikeClient(manager, AuthManager.PAT_USER_ID, fetchImpl as unknown as typeof fetch);

    const out = await client.getBinary('/attachments/IEAGIITRIMFWG6YH/download', {}, 0, 1024);
    expect(out.data.equals(bytes)).toBe(true);
  });

  it('tolerates a filename with a bare percent that is not valid percent-encoding', async () => {
    const manager = new AuthManager(patConfig, store);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(Buffer.from('x')), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          // decodeURIComponent('50% off.pdf') throws URIError — the '%' is
          // not followed by two hex digits.
          'Content-Disposition': 'attachment; filename="50% off.pdf"',
        },
      })
    );
    const client = new WrikeClient(manager, AuthManager.PAT_USER_ID, fetchImpl as unknown as typeof fetch);

    const out = await client.getBinary('/attachments/IEAGIITRIMFWG6YH/download');
    expect(out.filename).toBe('50% off.pdf');
  });
});
