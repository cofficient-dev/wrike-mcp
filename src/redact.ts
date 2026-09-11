import { WrikeApiError } from './wrikeClient.js';

/**
 * Central redaction for all outgoing responses and error text.
 *
 * Two layers: these patterns catch secrets that arrive in a recognised shape,
 * and registerSecret() scrubs configured secret values verbatim — a bare
 * secret quoted back by an upstream matches no pattern here.
 */
const SECRET_PATTERNS = [
  /access_token[=:][^\s&"]+/gi,
  /refresh_token[=:][^\s&"]+/gi,
  /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /wmc_[A-Za-z0-9\-._~+/]+/g,
];

/**
 * Literal secret values to scrub, registered at startup.
 *
 * The patterns above only match secrets that arrive in a recognised shape
 * (`access_token=...`, `Bearer ...`, `wmc_...`). A configured secret quoted
 * bare in a third-party error message matches none of them, so the values
 * themselves are registered and removed by exact match.
 */
const literalSecrets = new Set<string>();

/** Registers a configured secret so redact() scrubs it verbatim. */
export function registerSecret(value: string | undefined): void {
  // Short values would match far too much unrelated text.
  if (value && value.length >= 8) literalSecrets.add(value);
}

/** Test seam: forget registered literals. */
export function clearRegisteredSecrets(): void {
  literalSecrets.clear();
}

export function redact(text: string): string {
  let out = text;
  // Literals first: a pattern match could otherwise split a secret and leave
  // part of it behind.
  for (const secret of literalSecrets) out = out.split(secret).join('[REDACTED]');
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