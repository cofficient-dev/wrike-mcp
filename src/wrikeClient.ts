import type { AuthManager, UserId } from './auth/authManager.js';
import { AuthError } from './auth/authManager.js';

export interface WrikeResponse<T> {
  kind: string;
  data: T;
  nextPageToken?: string;
  size?: number;
}

export interface WrikeErrorResponse {
  error: string;
  errorDescription: string;
}

export class WrikeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WrikeApiError';
  }
}

export interface QueryParams {
  [key: string]: string | number | boolean | undefined;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Wrike API v4 client bound to a single user's credentials.
 * One instance per authenticated MCP request (cheap; holds no state).
 */
export class WrikeClient {
  constructor(
    private readonly authManager: AuthManager,
    private readonly userId: UserId,
    private readonly fetchImpl: HttpFetch = fetch
  ) {}

  private async doRequest<T>(
    method: HttpMethod,
    path: string,
    params: QueryParams,
    body: unknown,
    attempt: number
  ): Promise<WrikeResponse<T>> {
    const host = await this.authManager.getHost(this.userId);
    const token = await this.authManager.getAccessToken(this.userId);
    const url = new URL(`https://${host}/api/v4${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Authorization: `bearer ${token}`,
      Accept: 'application/json',
    };
    let bodyText: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(body);
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body: bodyText });

    if (!res.ok && res.status === 401 && attempt === 0 && this.authManager.authMode === 'oauth') {
      // Access token may be stale: force refresh and retry once.
      await this.authManager.refresh(this.userId);
      return this.doRequest(method, path, params, body, 1);
    }

    if (!res.ok && res.status === 429 && attempt < 2) {
      const retryAfterMs = Number(res.headers.get('Retry-After') ?? 0) || (attempt + 1) * 1000;
      await new Promise((r) => setTimeout(r, retryAfterMs));
      return this.doRequest(method, path, params, body, attempt + 1);
    }

    const json = (await res.json().catch(() => ({}))) as
      | WrikeResponse<T>
      | WrikeErrorResponse
      | Record<string, never>;
    if (!res.ok) {
      const err = json as WrikeErrorResponse;
      throw new WrikeApiError(
        res.status,
        err.error ?? 'unknown_error',
        `Wrike API error ${res.status} (${err.error ?? 'unknown_error'}): ${err.errorDescription ?? res.statusText}`
      );
    }
    return json as WrikeResponse<T>;
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    params: QueryParams = {},
    body?: unknown
  ): Promise<WrikeResponse<T>> {
    return this.doRequest<T>(method, path, params, body, 0);
  }

  /** Upload a file to Wrike as multipart/form-data (streams; never persisted). */
  async upload<T>(
    path: string,
    file: { name: string; contentType: string; data: Buffer },
    fields: Record<string, string> = {}
  ): Promise<WrikeResponse<T>> {
    const host = await this.authManager.getHost(this.userId);
    const token = await this.authManager.getAccessToken(this.userId);
    const url = new URL(`https://${host}/api/v4${path}`);
    for (const [k, v] of Object.entries(fields)) {
      url.searchParams.set(k, v);
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.name);
    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, Accept: 'application/json' },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as
      | WrikeResponse<T>
      | WrikeErrorResponse
      | Record<string, never>;
    if (!res.ok) {
      const err = json as WrikeErrorResponse;
      throw new WrikeApiError(
        res.status,
        err.error ?? 'unknown_error',
        `Wrike API error ${res.status} (${err.error ?? 'unknown_error'}): ${err.errorDescription ?? res.statusText}`
      );
    }
    return json as WrikeResponse<T>;
  }

  /**
   * Fetches a binary body (attachment content) rather than JSON.
   *
   * Every other call funnels through res.json(); GET /attachments/{id}/download
   * answers application/octet-stream, so parsing it as JSON would throw and the
   * bytes would be lost. Errors still come back as JSON, so those are decoded
   * on the failure path exactly as elsewhere.
   */
  async getBinary(
    path: string,
    params: QueryParams = {},
    attempt = 0
  ): Promise<{ data: Buffer; contentType: string; filename?: string }> {
    const host = await this.authManager.getHost(this.userId);
    const token = await this.authManager.getAccessToken(this.userId);
    const url = new URL(`https://${host}/api/v4${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `bearer ${token}`, Accept: '*/*' },
    });

    // Same recovery as doRequest: a stale access token, then rate limiting.
    if (!res.ok && res.status === 401 && attempt === 0 && this.authManager.authMode === 'oauth') {
      await this.authManager.refresh(this.userId);
      return this.getBinary(path, params, 1);
    }
    if (!res.ok && res.status === 429 && attempt < 2) {
      const retryAfterMs = Number(res.headers.get('Retry-After') ?? 0) || (attempt + 1) * 1000;
      await new Promise((r) => setTimeout(r, retryAfterMs));
      return this.getBinary(path, params, attempt + 1);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as WrikeErrorResponse;
      throw new WrikeApiError(
        res.status,
        err.error ?? 'unknown_error',
        `Wrike API error ${res.status} (${err.error ?? 'unknown_error'}): ${err.errorDescription ?? res.statusText}`
      );
    }

    const data = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return {
      data,
      contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
      ...(match?.[1] ? { filename: decodeURIComponent(match[1]) } : {}),
    };
  }

  // --- Convenience wrappers ---------------------------------------------------

  get<T>(path: string, params: QueryParams = {}): Promise<WrikeResponse<T>> {
    return this.request('GET', path, params);
  }

  post<T>(path: string, params: QueryParams = {}, body?: unknown): Promise<WrikeResponse<T>> {
    return this.request('POST', path, params, body);
  }

  put<T>(path: string, params: QueryParams = {}, body?: unknown): Promise<WrikeResponse<T>> {
    return this.request('PUT', path, params, body);
  }

  delete<T>(path: string, params: QueryParams = {}): Promise<WrikeResponse<T>> {
    return this.request('DELETE', path, params);
  }
}

export { AuthError };