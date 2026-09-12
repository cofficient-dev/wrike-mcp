import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AttachmentLinks } from '../src/auth/attachmentLinks.js';

const secret = randomBytes(32);
const baseUrl = 'https://mcp.example.com/wrike';

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

describe('AttachmentLinks', () => {
  it('issues a URL that verifies back to the issuing user for the same attachment', () => {
    const links = new AttachmentLinks(secret, baseUrl);
    const url = links.issue('alice', 'IEAGIITRIMFWG6YH');
    expect(url).toMatch(
      /^https:\/\/mcp\.example\.com\/wrike\/attachments\/IEAGIITRIMFWG6YH\/file\?token=/
    );
    expect(links.verify(tokenFrom(url), 'IEAGIITRIMFWG6YH')).toBe('alice');
  });

  it('rejects an expired token', () => {
    const links = new AttachmentLinks(secret, baseUrl, -1); // already expired the instant it's issued
    const url = links.issue('alice', 'ATT1');
    expect(links.verify(tokenFrom(url), 'ATT1')).toBeUndefined();
  });

  it('rejects a tampered payload (userId swapped, MAC now mismatched)', () => {
    const links = new AttachmentLinks(secret, baseUrl);
    const url = links.issue('alice', 'ATT1');
    const token = tokenFrom(url);
    const dot = token.lastIndexOf('.');
    const payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')) as {
      u: string;
      a: string;
      exp: number;
    };
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, u: 'mallory' })).toString('base64url');
    const tamperedToken = `${tamperedPayload}.${token.slice(dot + 1)}`;
    expect(links.verify(tamperedToken, 'ATT1')).toBeUndefined();
  });

  it('rejects a tampered MAC', () => {
    const links = new AttachmentLinks(secret, baseUrl);
    const url = links.issue('alice', 'ATT1');
    const token = tokenFrom(url);
    const dot = token.lastIndexOf('.');
    const badMac = token
      .slice(dot + 1)
      .split('')
      .reverse()
      .join('');
    expect(links.verify(`${token.slice(0, dot)}.${badMac}`, 'ATT1')).toBeUndefined();
  });

  it('rejects a token issued for a different attachment', () => {
    const links = new AttachmentLinks(secret, baseUrl);
    const url = links.issue('alice', 'ATT-A');
    // A leaked token for attachment A must not unlock attachment B.
    expect(links.verify(tokenFrom(url), 'ATT-B')).toBeUndefined();
  });

  it('rejects garbage tokens', () => {
    const links = new AttachmentLinks(secret, baseUrl);
    expect(links.verify('not-a-real-token', 'ATT1')).toBeUndefined();
    expect(links.verify('', 'ATT1')).toBeUndefined();
    expect(links.verify('.', 'ATT1')).toBeUndefined();
    expect(links.verify('onlypayload', 'ATT1')).toBeUndefined();
  });
});
