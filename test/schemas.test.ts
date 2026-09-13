import { describe, it, expect } from 'vitest';
import { WrikeIdSchema } from '../src/tools/schemas.js';

describe('WrikeIdSchema', () => {
  it('accepts a legacy 16-char uppercase+digit id', () => {
    expect(WrikeIdSchema.safeParse('IEACK5SYI7777777').success).toBe(true);
  });

  it('accepts a legacy 8-char uppercase+digit id', () => {
    expect(WrikeIdSchema.safeParse('KUABHKOF').success).toBe(true);
  });

  it('accepts the real new-format mixed-case id observed in production (the regression this fixes)', () => {
    // create_folder returned this exact id live; the old
    // ^[A-Z0-9]{16}$ / ^[A-Z0-9]{8,16}$ patterns rejected it on both
    // length (12 chars) and case (mixed), making anything this server
    // created immediately unreachable by every other tool.
    expect(WrikeIdSchema.safeParse('MQAAAAEPpWtv').success).toBe(true);
    expect(WrikeIdSchema.safeParse('MAAAAAEPpWr8').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(WrikeIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects a path traversal sequence', () => {
    expect(WrikeIdSchema.safeParse('../../etc').success).toBe(false);
  });

  it('rejects an id containing a slash', () => {
    expect(WrikeIdSchema.safeParse('ABC/DEF').success).toBe(false);
  });

  it('rejects an id containing a space', () => {
    expect(WrikeIdSchema.safeParse('ABC DEF').success).toBe(false);
  });
});
