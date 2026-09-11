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

/** A binary download exceeded the caller's byte budget. */
export class BinaryTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number
  ) {
    super(`response is ${actualBytes} bytes, over the ${maxBytes}-byte limit`);
    this.name = 'BinaryTooLargeError';
  }
}

/**
 * Reads a Response body into a Buffer, aborting once `maxBytes` is exceeded.
 *
 * A declared Content-Length can be checked before this runs, but Wrike (or
 * any proxy in front of it) is not obliged to send one — chunked transfer
 * encoding has none — so the only reliable enforcement is counting bytes as
 * they arrive and cancelling the stream the moment the budget is blown,
 * rather than buffering the whole body first and measuring it afterwards.
 */
async function readBodyWithLimit(res: Response, maxBytes?: number): Promise<Buffer> {
  if (maxBytes === undefined || !res.body) {
    return Buffer.from(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BinaryTooLargeError(total, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Decodes a Content-Disposition filename, tolerating a bare '%' that is not
 * valid percent-encoding (e.g. "50% off.pdf"). decodeURIComponent throws a
 * URIError on that input, which would otherwise turn an already-successful
 * download into a failed request over a detail as small as the file's name.
 */
function decodeFilename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Extracts the filename from a Content-Disposition header.
 *
 * RFC 6266 defines two forms, and senders may emit both (ext-value preferred):
 *   filename*=UTF-8''report%20v2.pdf   ext-value: charset, optional language,
 *                                      then percent-encoded (RFC 5987)
 *   filename="50% off.pdf"              quoted-string: literal, NOT encoded
 *   filename=report.pdf                 token: literal
 *
 * The charset prefix is skipped whatever it names — RFC 5987 permits more
 * than UTF-8 (iso-8859-1 and friends), so matching UTF-8 alone left the
 * prefix in the captured value. The bytes are percent-decoded regardless of
 * the declared charset; a single-byte charset whose encoding is not valid
 * UTF-8 falls back to the raw text via decodeFilename. The quoted-string form
 * is taken verbatim — decoding it would corrupt names like "50% off.pdf" —
 * and may contain ';' without being truncated.
 */
function dispositionFilename(disposition: string): string | undefined {
  const ext = /filename\*=\s*[a-z0-9-]*'[^']*'([^;\s]+)/i.exec(disposition);
  if (ext?.[1]) return decodeFilename(ext[1]);
  const quoted = /filename=\s*"((?:[^"\\]|\\.)*)"/i.exec(disposition);
  if (quoted?.[1]) return quoted[1].replace(/\\"/g, '"');
  const token = /filename=\s*([^;\s]+)/i.exec(disposition);
  return token?.[1] || undefined;
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

    // Pre-existing instance of the same leak fixed in getBinary below: a
    // failed response being retried, rather than read for its error body,
    // must have its body explicitly cancelled or undici keeps the socket
    // out of the connection pool until GC finalizes it.
    if (!res.ok && res.status === 401 && attempt === 0 && this.authManager.authMode === 'oauth') {
      // Access token may be stale: force refresh and retry once.
      await res.body?.cancel().catch(() => undefined);
      await this.authManager.refresh(this.userId);
      return this.doRequest(method, path, params, body, 1);
    }

    if (!res.ok && res.status === 429 && attempt < 2) {
      const retryAfterMs = Number(res.headers.get('Retry-After') ?? 0) || (attempt + 1) * 1000;
      await res.body?.cancel().catch(() => undefined);
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
    attempt = 0,
    maxBytes?: number
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
    // Neither branch reads the failed response's body, so it must be
    // cancelled explicitly before recursing — otherwise undici holds the
    // socket open (unread body keeps it out of the connection pool) until
    // GC finalizes it, on every retried call.
    if (!res.ok && res.status === 401 && attempt === 0 && this.authManager.authMode === 'oauth') {
      await res.body?.cancel().catch(() => undefined);
      await this.authManager.refresh(this.userId);
      return this.getBinary(path, params, 1, maxBytes);
    }
    if (!res.ok && res.status === 429 && attempt < 2) {
      const retryAfterMs = Number(res.headers.get('Retry-After') ?? 0) || (attempt + 1) * 1000;
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, retryAfterMs));
      return this.getBinary(path, params, attempt + 1, maxBytes);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as WrikeErrorResponse;
      throw new WrikeApiError(
        res.status,
        err.error ?? 'unknown_error',
        `Wrike API error ${res.status} (${err.error ?? 'unknown_error'}): ${err.errorDescription ?? res.statusText}`
      );
    }

    // Declared length check: rejects an oversized file before reading a
    // single byte of the body, when Wrike sends Content-Length (it does for
    // this endpoint). This alone is not sufficient — a chunked or lying
    // response has no reliable Content-Length — so it is paired with the
    // streamed budget below rather than replacing it.
    const declaredLength = Number(res.headers.get('Content-Length') ?? '');
    if (maxBytes !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new BinaryTooLargeError(declaredLength, maxBytes);
    }

    const data = await readBodyWithLimit(res, maxBytes);
    const filename = dispositionFilename(res.headers.get('Content-Disposition') ?? '');
    return {
      data,
      contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
      ...(filename !== undefined ? { filename } : {}),
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