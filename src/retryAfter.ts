/**
 * ponytail: caps the honoured Retry-After wait at 30s so a large (or
 * malformed-into-huge) value can't hang a request indefinitely. If Wrike's
 * real 429 windows turn out to routinely exceed this, raise the ceiling
 * rather than removing it.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Parses a Retry-After header (RFC 9110) into a wait in milliseconds.
 *
 * Only the delay-seconds form is handled — a bare number of seconds, with 0
 * being a legitimate "retry immediately" value. The header's HTTP-date form
 * is not parsed; a date-valued header falls through to the same fallback
 * backoff used when the header is absent or unparseable.
 */
export function parseRetryAfterMs(header: string | null, attempt: number): number {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return (attempt + 1) * 1000;
}
