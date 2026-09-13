import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../src/tools/toolDefinitions.js';
import { BinaryTooLargeError } from '../src/wrikeClient.js';
import type { WrikeClient } from '../src/wrikeClient.js';

function mockClient() {
  return {
    get: vi.fn().mockResolvedValue({ kind: 'ok', data: [] }),
    post: vi.fn().mockResolvedValue({ kind: 'ok', data: [{ id: 'X' }] }),
    put: vi.fn().mockResolvedValue({ kind: 'ok', data: [{ id: 'X' }] }),
    delete: vi.fn().mockResolvedValue({ kind: 'ok', data: [] }),
    upload: vi.fn().mockResolvedValue({ kind: 'attachments', data: [{ id: 'ATT' }] }),
    getBinary: vi.fn().mockResolvedValue({
      data: Buffer.from('PNGBYTES'),
      contentType: 'image/png',
      filename: 'shot.png',
    }),
    signedDownloadUrl: vi.fn().mockReturnValue({
      url: 'https://mcp.example.com/wrike/attachments/IEAGIITRIMFWG6YH/file?token=abc',
      expiresAt: '2026-01-01T00:15:00.000Z',
    }),
  } as unknown as WrikeClient;
}

const byName = (name: string) => buildTools().find((t) => t.name === name)!;

describe('tool validation and dispatch', () => {
  it('create_task requires folderId and title', async () => {
    const tool = byName('create_task');
    await expect(tool.handler(mockClient(), { title: 'no folder' })).rejects.toThrow();
    await expect(tool.handler(mockClient(), { folderId: 'IEAGIITR' })).rejects.toThrow();
  });

  it('create_task accepts the full task object (dates, effort, custom fields)', async () => {
    const client = mockClient();
    const tool = byName('create_task');
    const result = await tool.handler(client, {
      folderId: 'IEAGIITR',
      title: 'New task',
      description: 'desc',
      dates: { type: 'Planned', start: '2026-01-05T09:00:00Z', due: '2026-01-09T17:00:00Z', duration: 480, workOnWeekends: false },
      effortAllocation: {
        mode: 'Flexible',
        totalEffort: 600,
        responsibleAllocation: [{ id: 'KUAJ25LC', allocationPercentage: 50, startDate: '2026-01-05', endDate: '2026-01-09' }],
      },
      importance: 'High',
      status: 'Active',
      responsibles: ['KUAJ25LC'],
      followers: ['KUAJ25LC'],
      customFields: [{ id: 'MDI4NDA', value: 'v1' }],
      metadata: [{ key: 'k', value: 'v' }],
    });
    expect(result).toEqual({ kind: 'ok', data: [{ id: 'X' }] });
    const [path] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      unknown,
    ];
    expect(path).toBe('/folders/IEAGIITR/tasks');
    const [_, params, body] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(body.dates).toEqual({
      type: 'Planned',
      start: '2026-01-05T09:00:00Z',
      due: '2026-01-09T17:00:00Z',
      duration: 480,
      workOnWeekends: false,
    });
    expect(body.effortAllocation).toEqual({
      mode: 'Flexible',
      totalEffort: 600,
      responsibleAllocation: [{ id: 'KUAJ25LC', allocationPercentage: 50, startDate: '2026-01-05', endDate: '2026-01-09' }],
    });
    void params;
  });

  it('create_task rejects invalid importance and non-strict fields', async () => {
    const tool = byName('create_task');
    await expect(
      tool.handler(mockClient(), { folderId: 'IEAGIITR', title: 'x', importance: 'Bogus' })
    ).rejects.toThrow();
    await expect(
      tool.handler(mockClient(), { folderId: 'IEAGIITR', title: 'x', typoField: true })
    ).rejects.toThrow();
  });

  it('create_task rejects a Planned start date without due or duration', async () => {
    const tool = byName('create_task');
    await expect(
      tool.handler(mockClient(), {
        folderId: 'IEAGIITR',
        title: 'x',
        dates: { type: 'Planned', start: '2026-01-05' },
      })
    ).rejects.toThrow();
  });

  it('update_task routes to PUT /tasks/{id} with full fields', async () => {
    const client = mockClient();
    const tool = byName('update_task');
    await tool.handler(client, {
      taskId: 'TASK1234',
      effortAllocation: { mode: 'Daily', dailyAllocationPercentage: 50 },
      addResponsibles: ['KUAJ25LC'],
      restore: true,
    });
    const [path] = (client.put as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
    expect(path).toBe('/tasks/TASK1234/tasks/TASK1234'.replace('/tasks/TASK1234/tasks/TASK1234', '/tasks/TASK1234'));
  });

  it('list_spaces passes filters as query params', async () => {
    const client = mockClient();
    await byName('list_spaces').handler(client, { withArchived: true, title: 'Ops' });
    const [path, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe('/spaces');
    expect(params).toMatchObject({ withArchived: true, title: 'Ops' });
  });

  it('create_timelog validates required fields', async () => {
    const tool = byName('create_timelog');
    await expect(tool.handler(mockClient(), { taskId: 'TASK1234' })).rejects.toThrow();
    await expect(
      tool.handler(mockClient(), { taskId: 'TASK1234', comment: 'c', hours: 2, trackedDate: '2026-09-08' })
    ).resolves.toEqual({ kind: 'ok', data: [{ id: 'X' }] });
    await expect(
      tool.handler(mockClient(), { taskId: 'TASK1234', comment: 'c', hours: 2, trackedDate: '08-09-2026' })
    ).rejects.toThrow();
  });

  it('list_timelogs scopes to folder when folderId given', async () => {
    const client = mockClient();
    await byName('list_timelogs').handler(client, { folderId: 'IEAGIITR', startDate: '2026-01-01' });
    const [path] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
    expect(path).toBe('/folders/IEAGIITR/timelogs');
  });

  it('create_attachment base64-decodes content and calls upload', async () => {
    const client = mockClient();
    const tool = byName('create_attachment');
    await tool.handler(client, {
      targetType: 'tasks',
      targetId: 'TASK1234',
      filename: 'a.txt',
      content: Buffer.from('file body').toString('base64'),
      comment: 'attached by MCP',
    });
    const [path, file] = (client.upload as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      string,
      { name: string; data: Buffer },
    ];
    expect(path).toBe('/tasks/TASK1234/attachments');
    expect(file.name).toBe('a.txt');
    expect(file.data.toString()).toBe('file body');
  });

  it('add_comment routes tasks vs folders', async () => {
    const client = mockClient();
    await byName('add_comment').handler(client, { targetType: 'folders', targetId: 'IEAGIITR', text: 'hi' });
    const [path] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
    expect(path).toBe('/folders/IEAGIITR/comments');
  });

  it('every tool has a name and description', () => {
    const tools = buildTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('rejects unknown fields strictly (no passthrough)', async () => {
    await expect(
      byName('get_task').handler(mockClient(), { taskId: 'TASK1234', bogus: 1 })
    ).rejects.toThrow();
  });

  describe('new-format (mixed-case) ids', () => {
    // Live sweep regression: create_folder returned id MQAAAAEPpWtv, and
    // passing that exact id straight back into another tool was rejected
    // client-side by the old ^[A-Z0-9]{8,16}$ id patterns before the request
    // ever reached Wrike. Anything created through this server was
    // immediately unreachable. WrikeIdSchema (schemas.ts) fixes this; these
    // are the round trips the sweep found broken.
    const NEW_FORMAT_ID = 'MQAAAAEPpWtv';

    it('create_task accepts a new-format folderId', async () => {
      const client = mockClient();
      await expect(
        byName('create_task').handler(client, { folderId: NEW_FORMAT_ID, title: 'x' })
      ).resolves.toBeDefined();
      const [path] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
      expect(path).toBe(`/folders/${NEW_FORMAT_ID}/tasks`);
    });

    it('get_task accepts a new-format taskId', async () => {
      const client = mockClient();
      await expect(
        byName('get_task').handler(client, { taskId: NEW_FORMAT_ID })
      ).resolves.toBeDefined();
      const [path] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
      expect(path).toBe(`/tasks/${NEW_FORMAT_ID}`);
    });

    it('add_comment accepts a new-format targetId', async () => {
      const client = mockClient();
      await expect(
        byName('add_comment').handler(client, { targetType: 'tasks', targetId: NEW_FORMAT_ID, text: 'hi' })
      ).resolves.toBeDefined();
      const [path] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
      expect(path).toBe(`/tasks/${NEW_FORMAT_ID}/comments`);
    });
  });
});
describe('attachment download', () => {
  it("get_attachment returns metadata only when mode is not set (defaults to 'metadata')", async () => {
    const client = mockClient();
    await byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH' });
    const [path, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/attachments/IEAGIITRIMFWG6YH');
    // The metadata endpoint supports only `versions`; withUrl(s) is rejected by Wrike.
    expect(params).not.toHaveProperty('withUrl');
    expect(params).not.toHaveProperty('withUrls');
    expect(client.getBinary as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(client.signedDownloadUrl as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("get_attachment returns metadata only when mode: 'metadata' is explicit", async () => {
    const client = mockClient();
    await byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'metadata' });
    expect(client.get as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(client.getBinary as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("get_attachment with mode: 'download' returns base64 file content plus a do-not-relay note", async () => {
    const client = mockClient();
    const result = (await byName('get_attachment').handler(client, {
      attachmentId: 'IEAGIITRIMFWG6YH',
      mode: 'download',
    })) as Record<string, unknown>;

    const [path] = (client.getBinary as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/attachments/IEAGIITRIMFWG6YH/download');
    expect(result.encoding).toBe('base64');
    expect(Buffer.from(result.content as string, 'base64').toString()).toBe('PNGBYTES');
    expect(result.contentType).toBe('image/png');
    expect(result.filename).toBe('shot.png');
    expect(result.size).toBe(8);
    // The field the caller is already reading, telling it not to retype this
    // content verbatim to a person and to use mode: 'url' instead.
    expect(typeof result.note).toBe('string');
    expect(result.note as string).toMatch(/mode: 'url'/);
  });

  it("get_attachment passes a byte budget to getBinary for mode: 'download' so oversized files are rejected before buffering", async () => {
    const client = mockClient();
    await byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'download' });
    const call = (client.getBinary as ReturnType<typeof vi.fn>).mock.calls[0];
    // Enforcement lives inside getBinary (Content-Length check, then a
    // streamed cutoff) precisely so an oversized body is never fully
    // buffered here first — the handler only supplies the budget.
    expect(call[3]).toBeGreaterThan(0);
  });

  it("get_attachment turns BinaryTooLargeError into a message naming mode: 'url'", async () => {
    const client = mockClient();
    (client.getBinary as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new BinaryTooLargeError(6 * 1024 * 1024, 5 * 1024 * 1024)
    );
    await expect(
      byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'download' })
    ).rejects.toThrow(/mode: 'url'/);
  });

  it("get_attachment lets a non-size error from getBinary pass through unchanged for mode: 'download'", async () => {
    const client = mockClient();
    (client.getBinary as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network blip'));
    await expect(
      byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'download' })
    ).rejects.toThrow('network blip');
  });

  it("get_attachment with mode: 'url' returns a signed URL and makes no Wrike HTTP call", async () => {
    const client = mockClient();
    const result = (await byName('get_attachment').handler(client, {
      attachmentId: 'IEAGIITRIMFWG6YH',
      mode: 'url',
    })) as Record<string, unknown>;

    expect(client.signedDownloadUrl as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('IEAGIITRIMFWG6YH');
    expect(result).toEqual({
      attachmentId: 'IEAGIITRIMFWG6YH',
      url: 'https://mcp.example.com/wrike/attachments/IEAGIITRIMFWG6YH/file?token=abc',
      expiresAt: '2026-01-01T00:15:00.000Z',
    });
    // Minting a URL is purely local signing — no metadata GET, no binary download.
    expect(client.get as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(client.getBinary as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("get_attachment mode: 'url' surfaces a clear error when PUBLIC_BASE_URL is not configured", async () => {
    const client = mockClient();
    (client.signedDownloadUrl as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // What WrikeClient.signedDownloadUrl itself throws when unconfigured.
      throw new Error(
        "Signed download links are not available: this server has no PUBLIC_BASE_URL configured. " +
        "Set PUBLIC_BASE_URL, or use mode: 'download' instead."
      );
    });
    await expect(
      byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'url' })
    ).rejects.toThrow(/PUBLIC_BASE_URL/);
  });

  it('get_attachment rejects an unknown key (strict schema)', async () => {
    // Coverage for GetAttachmentSchema's .strict(): any unrecognized key must
    // be rejected, not silently dropped.
    await expect(
      byName('get_attachment').handler(mockClient(), {
        attachmentId: 'IEAGIITRIMFWG6YH',
        bogusField: true,
      })
    ).rejects.toThrow();
  });

  it('get_attachment rejects an invalid mode value', async () => {
    await expect(
      byName('get_attachment').handler(mockClient(), {
        attachmentId: 'IEAGIITRIMFWG6YH',
        mode: 'bogus',
      })
    ).rejects.toThrow();
  });

  it('list_attachments sends withUrls, not withUrl', async () => {
    const client = mockClient();
    await byName('list_attachments').handler(client, {
      targetType: 'tasks',
      targetId: 'IEAGIITR',
      withUrls: true,
    });
    const [path, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/tasks/IEAGIITR/attachments');
    expect(params).toMatchObject({ withUrls: true });
    expect(params).not.toHaveProperty('withUrl');
    // `fields` is not supported on this endpoint and was previously sent.
    expect(params).not.toHaveProperty('fields');
  });
});
describe('search', () => {
  // Wrike has no unified search endpoint; `search` fans out to GET /tasks,
  // GET /folders, and GET /contacts. mockClient() above answers every `get`
  // call identically, which would let a call to the wrong path (or the old,
  // nonexistent /search) go unnoticed — so this needs a client whose `get`
  // resolves (or rejects) per path.
  function mockSearchClient(overrides: Record<string, unknown> = {}) {
    const responses: Record<string, unknown> = {
      '/tasks': { kind: 'tasks', data: [{ id: 'T1', title: 'Task one' }, { id: 'T2', title: 'Task two' }] },
      '/folders': { kind: 'folders', data: [{ id: 'F1', title: 'Folder one' }] },
      '/contacts': { kind: 'contacts', data: [{ id: 'C1', name: 'Contact one' }] },
      ...overrides,
    };
    const get = vi.fn(async (path: string) => {
      const res = responses[path];
      if (res instanceof Error) throw res;
      return res;
    });
    return { get } as unknown as WrikeClient;
  }

  it('fans out to /tasks, /folders, /contacts with the right filter param per target, and never calls /search', async () => {
    const client = mockSearchClient();
    await byName('search').handler(client, { query: 'invoice' });

    const calls = (client.get as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
    const byPath = Object.fromEntries(calls.map(([path, params]) => [path, params]));

    expect(Object.keys(byPath).sort()).toEqual(['/contacts', '/folders', '/tasks']);
    // The original bug: /tasks and /folders filter on `title`, /contacts on `name`.
    // Mixing these up is exactly what shipped broken.
    expect(byPath['/tasks']).toMatchObject({ title: 'invoice' });
    expect(byPath['/folders']).toMatchObject({ title: 'invoice' });
    expect(byPath['/contacts']).toMatchObject({ name: 'invoice' });
    expect(byPath['/contacts']).not.toHaveProperty('title');

    // Regression guard: there is no /search endpoint in Wrike API v4.
    expect(calls.some(([path]) => path === '/search')).toBe(false);
  });

  it('merges results into the grouped { query, tasks, folders, contacts } shape', async () => {
    const client = mockSearchClient();
    const result = (await byName('search').handler(client, { query: 'invoice' })) as {
      query: string;
      tasks?: unknown[];
      folders?: unknown[];
      contacts?: unknown[];
      errors?: unknown[];
    };

    expect(result.query).toBe('invoice');
    expect(result.tasks).toEqual([{ id: 'T1', title: 'Task one' }, { id: 'T2', title: 'Task two' }]);
    expect(result.folders).toEqual([{ id: 'F1', title: 'Folder one' }]);
    expect(result.contacts).toEqual([{ id: 'C1', name: 'Contact one' }]);
    expect(result.errors).toBeUndefined();
  });

  it('returns the other two targets when one fails, naming the failure in errors', async () => {
    const client = mockSearchClient({
      '/contacts': new Error('Wrike API error 403 (forbidden): access denied'),
    });
    const result = (await byName('search').handler(client, { query: 'invoice' })) as {
      tasks?: unknown[];
      folders?: unknown[];
      contacts?: unknown[];
      errors?: { target: string; error: string }[];
    };

    expect(result.tasks).toBeDefined();
    expect(result.folders).toBeDefined();
    expect(result.contacts).toBeUndefined();
    expect(result.errors).toEqual([
      { target: 'contacts', error: 'Wrike API error 403 (forbidden): access denied' },
    ]);
  });

  it('deduplicates targets so a repeat does not fire duplicate requests', async () => {
    const client = mockSearchClient();
    await byName('search').handler(client, {
      query: 'invoice',
      targets: ['tasks', 'tasks', 'folders', 'tasks'],
    });

    const calls = (client.get as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls.filter(([path]) => path === '/tasks')).toHaveLength(1);
    expect(calls.map(([path]) => path).sort()).toEqual(['/folders', '/tasks']);
  });

  it('reports a failing target once even when it was requested twice', async () => {
    const client = mockSearchClient({
      '/contacts': new Error('Wrike API error 403 (forbidden): access denied'),
    });
    const result = (await byName('search').handler(client, {
      query: 'invoice',
      targets: ['contacts', 'contacts', 'tasks'],
    })) as { errors?: { target: string }[] };

    expect(result.errors).toHaveLength(1);
  });

  it('throws when every target fails, rather than returning an empty success', async () => {
    // A systemic failure (expired token, Wrike down) must not come back as
    // { query, errors } with no results — that is success-shaped and reads at
    // the call site exactly like a search that legitimately found nothing.
    const client = mockSearchClient({
      '/tasks': new Error('Wrike API error 401 (not_authorized): token expired'),
      '/folders': new Error('Wrike API error 401 (not_authorized): token expired'),
      '/contacts': new Error('Wrike API error 401 (not_authorized): token expired'),
    });
    await expect(byName('search').handler(client, { query: 'invoice' })).rejects.toThrow(/every target/i);
  });

  it('still throws when the single requested target fails', async () => {
    // "every target failed" is relative to what was asked for, not to all three.
    const client = mockSearchClient({
      '/tasks': new Error('Wrike API error 500 (server_error): upstream'),
    });
    await expect(
      byName('search').handler(client, { query: 'invoice', targets: ['tasks'] })
    ).rejects.toThrow(/every target/i);
  });

  it('limit is honoured per target: passed natively where documented, then sliced client-side', async () => {
    const client = mockSearchClient({
      '/tasks': { kind: 'tasks', data: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] },
      '/folders': { kind: 'folders', data: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }] },
      '/contacts': { kind: 'contacts', data: [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }] },
    });
    const result = (await byName('search').handler(client, { query: 'invoice', limit: 2 })) as {
      tasks?: unknown[];
      folders?: unknown[];
      contacts?: unknown[];
    };

    expect(result.tasks).toHaveLength(2);
    expect(result.folders).toHaveLength(2);
    expect(result.contacts).toHaveLength(2);

    const calls = (client.get as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
    const byPath = Object.fromEntries(calls.map(([path, params]) => [path, params]));
    expect(byPath['/tasks']).toMatchObject({ limit: 2 });
    expect(byPath['/folders']).toMatchObject({ pageSize: 2 });
    // /contacts documents neither `limit` nor `pageSize` — must not be sent one.
    expect(byPath['/contacts']).not.toHaveProperty('limit');
    expect(byPath['/contacts']).not.toHaveProperty('pageSize');
  });

  it('targets narrows the fan-out to only the requested endpoints', async () => {
    const client = mockSearchClient();
    const result = (await byName('search').handler(client, {
      query: 'invoice',
      targets: ['tasks'],
    })) as { tasks?: unknown[]; folders?: unknown[]; contacts?: unknown[] };

    expect(client.get as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/tasks');
    expect(result.tasks).toBeDefined();
    expect(result.folders).toBeUndefined();
    expect(result.contacts).toBeUndefined();
  });

  it('description states contains-matching, undocumented contact semantics, and per-target limit', () => {
    const tool = byName('search');
    expect(tool.description).toMatch(/contains-match/i);
    expect(tool.description).toMatch(/does not document/i);
    expect(tool.description).toMatch(/per target/i);
  });
});
