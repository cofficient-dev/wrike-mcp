import { WrikeApiError } from './wrikeClient.js';

/**
 * Central redaction for all outgoing responses and error text.
 * Covers Wrike tokens, client secrets, and this server's connection tokens.
 */
const SECRET_PATTERNS = [
  /access_token[=:][^\s&"]+/gi,
  /refresh_token[=:][^\s&"]+/gi,
  /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /wmc_[A-Za-z0-9\-._~+/]+/g,
];

export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof WrikeApiError) {
    return `Wrike API error ${err.status} (${err.code}): ${err.message.replace(/^.*?: /, '')}`;
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (/access_token|refresh_token|client_secret/i.test(msg)) {
      return 'Authentication error: token redacted. Re-authorize via /connect.';
    }
    return msg;
  }
  return String(err);
}