import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mints and verifies short-lived signed download links for Wrike attachments.
 *
 * Exists so `get_attachment` never has to put file bytes inside an MCP tool
 * result: `mode: 'url'` hands back one of these links instead, the caller's
 * browser fetches it directly from this server's `/attachments/:id/file`
 * route, and the model only ever handles a short URL — not a multi-thousand
 * character base64 string it would otherwise have to reproduce token-by-token.
 *
 * Token shape mirrors the resume token in `mcpOauth.ts`
 * (`issueResumeToken`/`verifyResumeToken`): a base64url JSON payload, a '.',
 * then an HMAC over the payload, compared in constant time. The payload
 * binds one specific attachment id, so a leaked token cannot be replayed
 * against a different attachment in the same user's library.
 */
export class AttachmentLinks {
  private readonly key: Buffer;

  constructor(
    secret: Buffer,
    private readonly publicBaseUrl: string,
    /** Token lifetime in ms. The single source of truth for link expiry — callers that need an expiresAt read it from here rather than keeping their own copy of this number. */
    public readonly ttlMs: number = 15 * 60_000
  ) {
    // Derive a key scoped to this one purpose rather than using the raw
    // config secret directly — same move as McpOAuthServer over
    // config.clientSecret: a signature forged with this key cannot be
    // replayed against anything else that also holds tokenEncryptionKey.
    this.key = createHmac('sha256', 'wrike-mcp-attachment-links').update(secret).digest();
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  /** Mints an absolute, single-attachment, expiring download URL. */
  issue(userId: string, attachmentId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ u: userId, a: attachmentId, exp: Date.now() + this.ttlMs })
    ).toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;
    return `${this.publicBaseUrl}/attachments/${encodeURIComponent(attachmentId)}/file?token=${encodeURIComponent(token)}`;
  }

  /**
   * Verifies a token against the attachment id it is being presented for.
   * Returns the bound userId, or undefined for anything invalid, expired,
   * tampered (payload or MAC), or issued for a different attachment.
   */
  verify(token: string, attachmentId: string): string | undefined {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const payload = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return undefined;
    let parsed: { u?: unknown; a?: unknown; exp?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
      return undefined;
    }
    if (typeof parsed.u !== 'string' || typeof parsed.a !== 'string' || typeof parsed.exp !== 'number') {
      return undefined;
    }
    if (parsed.exp <= Date.now()) return undefined;
    if (parsed.a !== attachmentId) return undefined;
    return parsed.u;
  }
}
