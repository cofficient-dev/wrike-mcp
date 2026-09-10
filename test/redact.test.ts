import { describe, it, expect } from 'vitest';
import { redact, registerSecret, clearRegisteredSecrets } from '../src/redact.js';

describe('redact', () => {
    it('scrubs secrets that arrive in a recognised shape', () => {
        expect(redact('access_token=abc123def')).toBe('[REDACTED]');
        expect(redact('Authorization: Bearer abc123def')).toContain('[REDACTED]');
        expect(redact('token wmc_abc123 used')).toBe('token [REDACTED] used');
    });

    it('scrubs a registered secret quoted bare in third-party text', () => {
        clearRegisteredSecrets();
        // A configured secret can reach an error message without any of the
        // shapes above around it — e.g. quoted back by an upstream API.
        registerSecret('sUp3r-s3cret-value');
        expect(redact('upstream said: invalid credential "sUp3r-s3cret-value"')).toBe(
            'upstream said: invalid credential "[REDACTED]"'
        );
        expect(redact('sUp3r-s3cret-value sUp3r-s3cret-value')).toBe('[REDACTED] [REDACTED]');
    });

    it('ignores short values that would over-match', () => {
        clearRegisteredSecrets();
        registerSecret('abc');
        expect(redact('abc def')).toBe('abc def');
    });

    it('tolerates regex metacharacters in a secret', () => {
        clearRegisteredSecrets();
        registerSecret('a.b*c[d]+e');
        expect(redact('value a.b*c[d]+e here')).toBe('value [REDACTED] here');
        // Not treated as a pattern: the literal text is what matches.
        expect(redact('value axbxcxdxxe here')).toBe('value axbxcxdxxe here');
    });
});
