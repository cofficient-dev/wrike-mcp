import { describe, it, expect } from 'vitest';
import { WrikeIdSchema } from '../src/tools/schemas.js';
import { buildTools } from '../src/tools/toolDefinitions.js';
import { vi } from 'vitest';
import type { WrikeClient } from '../src/wrikeClient.js';

const mockDeleteClient = () =>
  ({ delete: vi.fn().mockResolvedValue({ kind: 'ok', data: [] }) }) as unknown as WrikeClient;

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

describe('WrikeIdSchema length bound', () => {
  it('accepts ids far longer than anything Wrike currently mints', () => {
    // The cap is a sanity bound, not a format claim — the bug this schema
    // fixes was a bound drawn tightly around the ids visible at the time.
    expect(() => WrikeIdSchema.parse('A'.repeat(64))).not.toThrow();
    expect(() => WrikeIdSchema.parse('A'.repeat(128))).not.toThrow();
  });

  it('rejects an absurdly long id being pushed through as a path segment', () => {
    expect(() => WrikeIdSchema.parse('A'.repeat(129))).toThrow();
    expect(() => WrikeIdSchema.parse('A'.repeat(10_000))).toThrow();
  });
});

describe('tool input schemas stay plain ZodObjects', () => {
  it('every tool schema exposes .shape', () => {
    // The MCP SDK registers a tool by reading its input schema's .shape, so a
    // top-level schema wrapped by .refine() (a ZodEffects) breaks registration
    // for *every* tool with "expected a zod object schema". Caught exactly
    // that while adding a folderId/taskId exclusivity refine to
    // ListTimelogsSchema; the check moved to the handler instead.
    for (const tool of buildTools()) {
      expect(
        (tool.inputSchema as { shape?: unknown }).shape,
        `${tool.name} input schema must be a plain ZodObject`
      ).toBeDefined();
    }
  });
});

describe('delete schemas guard path-interpolated ids', () => {
  // Every delete handler builds a path (`/folders/${id}`, `/tasks/${id}`,
  // `/timelogs/${id}`, `/attachments/${id}`), so these need the same guard as
  // every other id — they were the last plain z.string() ids in the file.
  const cases: [string, string][] = [
    ['delete_folder', 'folderId'],
    ['delete_task', 'taskId'],
    ['delete_timelog', 'timelogId'],
    ['delete_attachment', 'attachmentId'],
  ];

  for (const [tool, field] of cases) {
    it(`${tool} rejects a traversal-shaped ${field} but accepts a real id`, async () => {
      const t = buildTools().find((x) => x.name === tool)!;
      await expect(t.handler(mockDeleteClient(), { [field]: '../../account' })).rejects.toThrow();
      await expect(t.handler(mockDeleteClient(), { [field]: 'a/b' })).rejects.toThrow();
      // New-format mixed-case id must still pass — deletes were the one path
      // that kept working during the live sweep precisely because they were
      // unvalidated, so tightening them must not undo that.
      await expect(t.handler(mockDeleteClient(), { [field]: 'MQAAAAEPpWtv' })).resolves.toBeDefined();
    });
  }
});
