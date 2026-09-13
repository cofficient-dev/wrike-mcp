import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../src/tools/toolDefinitions.js';
import { BinaryTooLargeError, WrikeApiError } from '../src/wrikeClient.js';
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

  it('get_folder_tree hits /folders/{id}/folders with descendants, never /folders/{id}', async () => {
    // Live sweep regression: GET /folders/{folderId} rejects `descendants`
    // outright ("400 invalid_request: Parameter 'descendants' is not
    // allowed") on every folder id, so this tool never worked. The
    // documented subfolder-tree endpoint is /folders/{folderId}/folders.
    const client = mockClient();
    await byName('get_folder_tree').handler(client, { folderId: 'IEAGIITRIMFWG6YH' });
    const [path, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe('/folders/IEAGIITRIMFWG6YH/folders');
    expect(params).toMatchObject({ descendants: 'true' });
    expect(client.get as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
      '/folders/IEAGIITRIMFWG6YH',
      expect.anything()
    );
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

  describe('list_timelogs', () => {
    // Live sweep found: contactIds -> "Parameter 'contactIds' is not
    // allowed"; startDate -> "Parameter 'startDate' is not allowed"; an
    // unfiltered call returned the account's entire timelog history
    // (~257,000 lines) in one response because Wrike returns everything
    // when neither pageSize nor limit is given.

    it('scopes to folder when folderId is given', async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, { folderId: 'IEAGIITR' });
      const [path] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
      expect(path).toBe('/folders/IEAGIITR/timelogs');
    });

    it('scopes to task when taskId is given', async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, { taskId: 'TASK1234' });
      const [path] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
      expect(path).toBe('/tasks/TASK1234/timelogs');
    });

    it('hits the account-wide endpoint when neither folderId nor taskId is given', async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, {});
      const [path] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
      expect(path).toBe('/timelogs');
    });

    it('rejects the removed contactIds, startDate, endDate params', async () => {
      await expect(
        byName('list_timelogs').handler(mockClient(), { contactIds: ['KUABHKOF'] })
      ).rejects.toThrow();
      await expect(
        byName('list_timelogs').handler(mockClient(), { startDate: '2026-01-01' })
      ).rejects.toThrow();
      await expect(
        byName('list_timelogs').handler(mockClient(), { endDate: '2026-01-01' })
      ).rejects.toThrow();
    });

    it('sends a bounded default pageSize when the caller gives no pageSize', async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, {});
      const [, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(params.pageSize).toBe(200);
      expect(params).not.toHaveProperty('limit');
    });

    it("respects the caller's own pageSize instead of overriding it", async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, { pageSize: 50 });
      const [, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(params.pageSize).toBe(50);
    });

    it('still bounds the response when only limit is given', async () => {
      // Only pageSize bounds a single response; limit caps the total across
      // pages. Keying the default on "neither given" let limit suppress it, so
      // a large limit reproduced the whole-account response this is here to
      // prevent.
      const client = mockClient();
      await byName('list_timelogs').handler(client, { limit: 100000 });
      const [, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(params.limit).toBe(100000);
      expect(params.pageSize).toBe(200);
    });

    it('passes a small caller limit through alongside the default pageSize', async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, { limit: 10 });
      const [, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(params.limit).toBe(10);
      expect(params.pageSize).toBe(200);
    });

    it('does not inject a default pageSize onto a nextPageToken continuation', async () => {
      // The token resumes an already-paged query and carries that context —
      // Wrike's docs say pageSize "can be omitted in this case". Injecting a
      // default would silently re-page a caller who started with another size.
      const client = mockClient();
      await byName('list_timelogs').handler(client, { nextPageToken: 'tok123' });
      const [, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(params.nextPageToken).toBe('tok123');
      expect(params).not.toHaveProperty('pageSize');
    });

    it("still honours an explicit pageSize alongside a continuation token", async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, { nextPageToken: 'tok123', pageSize: 500 });
      const [, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(params.pageSize).toBe(500);
    });

    it('keeps routing to the folder endpoint when folderId is repeated alongside nextPageToken', async () => {
      // Endpoint selection is keyed on folderId/taskId, not on the token, so
      // a paged folder-scoped query must still resolve to the folder
      // endpoint when the caller repeats folderId on the next page.
      const client = mockClient();
      await byName('list_timelogs').handler(client, {
        folderId: 'IEAGIITR',
        nextPageToken: 'tok123',
      });
      const [path, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/folders/IEAGIITR/timelogs');
      expect(params.nextPageToken).toBe('tok123');
    });

    it('rejects folderId and taskId together rather than silently preferring one', async () => {
      // They select different endpoints; preferring folderId would return
      // folder-scoped results that read as task-scoped.
      await expect(
        byName('list_timelogs').handler(mockClient(), { folderId: 'IEAGIITR', taskId: 'TASK1234' })
      ).rejects.toThrow(/not both/i);
    });

    it('rejects a folderId or taskId shaped like a path traversal', async () => {
      // Both are interpolated into the request path by the handler.
      await expect(
        byName('list_timelogs').handler(mockClient(), { folderId: '../../account' })
      ).rejects.toThrow();
      await expect(
        byName('list_timelogs').handler(mockClient(), { taskId: 'a/b' })
      ).rejects.toThrow();
    });

    it('sends trackedDate as a range object, not loose startDate/endDate params', async () => {
      const client = mockClient();
      await byName('list_timelogs').handler(client, {
        trackedDate: { start: '2026-01-01T00:00:00', end: '2026-01-31T23:59:59' },
      });
      const [, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(JSON.parse(params.trackedDate as string)).toEqual({
        start: '2026-01-01T00:00:00',
        end: '2026-01-31T23:59:59',
      });
    });

    it('accepts the documented filters (timelogCategories, exportStatuses, billingTypes, approvalStatuses, me, descendants)', async () => {
      await expect(
        byName('list_timelogs').handler(mockClient(), {
          timelogCategories: ['CAT1'],
          exportStatuses: ['Exported'],
          billingTypes: ['Billable'],
          approvalStatuses: ['Approved'],
          me: true,
          descendants: false,
        })
      ).resolves.toBeDefined();
    });
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

  it("get_attachment description steers a person's download/get/save request to mode: 'url' first, and still flags the external-hosting restriction on mode: 'download'", () => {
    const { description } = byName('get_attachment');
    // The decision rule has to be read before the calling model reaches
    // mode: 'download', not discovered as a prohibition after the fact.
    expect(description.indexOf("mode: 'url'")).toBeLessThan(description.indexOf("mode: 'download'"));
    expect(description).toMatch(/download/i);
    expect(description).toMatch(/get me/i);
    expect(description).toMatch(/save/i);
    expect(description).toMatch(/externally hosted attachment/i);
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

  it("get_attachment with mode: 'url' checks the attachment is Wrike-hosted, then returns a signed URL", async () => {
    const client = mockClient();
    // mockClient's default `get` returns an empty data array, i.e. no `type`
    // reported — treated the same as type: 'Wrike'.
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
    // Minting still involves one metadata GET (to rule out an externally
    // hosted attachment) but no binary download.
    expect(client.get as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(client.getBinary as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("get_attachment with mode: 'url' still mints a link when metadata reports type: 'Wrike', without asking a parent listing", async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'attachments',
      data: [{ id: 'IEAGIITRIMFWG6YH', type: 'Wrike', taskId: 'IEAGIITR' }],
    });
    const result = (await byName('get_attachment').handler(client, {
      attachmentId: 'IEAGIITRIMFWG6YH',
      mode: 'url',
    })) as Record<string, unknown>;
    expect(result.url).toBe('https://mcp.example.com/wrike/attachments/IEAGIITRIMFWG6YH/file?token=abc');
    // Only the one metadata GET — a Wrike-hosted file never needs the parent listing.
    expect(client.get as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("get_attachment with mode: 'url' resolves the provider's own URL for an externally hosted attachment on a task", async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        kind: 'attachments',
        data: [{ id: 'IEAGIITRIMFWG6YH', type: 'OneDrive', taskId: 'IEAGIITR' }],
      })
      .mockResolvedValueOnce({
        kind: 'attachments',
        data: [{ id: 'IEAGIITRIMFWG6YH', url: 'https://cofficientcouk.sharepoint.com/file123' }],
      });
    const result = (await byName('get_attachment').handler(client, {
      attachmentId: 'IEAGIITRIMFWG6YH',
      mode: 'url',
    })) as Record<string, unknown>;

    expect(result).toEqual({
      attachmentId: 'IEAGIITRIMFWG6YH',
      url: 'https://cofficientcouk.sharepoint.com/file123',
      type: 'OneDrive',
      note: expect.any(String),
    });
    expect(result).not.toHaveProperty('expiresAt');
    expect(client.signedDownloadUrl as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const [path, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(path).toBe('/tasks/IEAGIITR/attachments');
    expect(params).toMatchObject({ withUrls: true });
  });

  it("get_attachment with mode: 'url' resolves the provider's own URL for an externally hosted attachment on a folder", async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        kind: 'attachments',
        data: [{ id: 'IEAGIITRIMFWG6YH', type: 'SharePoint', folderId: 'IEAGIIFOLDER' }],
      })
      .mockResolvedValueOnce({
        kind: 'attachments',
        data: [{ id: 'IEAGIITRIMFWG6YH', url: 'https://cofficientcouk.sharepoint.com/file456' }],
      });
    const result = (await byName('get_attachment').handler(client, {
      attachmentId: 'IEAGIITRIMFWG6YH',
      mode: 'url',
    })) as Record<string, unknown>;

    expect(result.url).toBe('https://cofficientcouk.sharepoint.com/file456');
    expect(result.type).toBe('SharePoint');
    const [path, params] = (client.get as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(path).toBe('/folders/IEAGIIFOLDER/attachments');
    expect(params).toMatchObject({ withUrls: true });
  });

  it("get_attachment with mode: 'url' throws when an externally hosted attachment's metadata names no parent", async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'attachments',
      data: [{ id: 'IEAGIITRIMFWG6YH', type: 'OneDrive' }],
    });
    // Distinct from the "listing came back empty" case below: here we never
    // queried a parent at all, so it is still reasonable to suggest the
    // caller run list_attachments themselves if they know the parent.
    await expect(
      byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'url' })
    ).rejects.toThrow(
      /OneDrive.*names no parent task or folder.*If you know the task or folder.*list_attachments.*withUrls/s
    );
    expect(client.signedDownloadUrl as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("get_attachment with mode: 'url' throws a different message when the parent listing has no matching URL", async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        kind: 'attachments',
        data: [{ id: 'IEAGIITRIMFWG6YH', type: 'OneDrive', taskId: 'IEAGIITR' }],
      })
      .mockResolvedValueOnce({ kind: 'attachments', data: [] }); // no matching id in the listing
    // We already made exactly the withUrls: true query and it came back
    // empty, so this message must not send the caller round that same loop —
    // no "try list_attachments" here, and it must name the parent queried.
    let caught: Error | undefined;
    try {
      await byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'url' });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toMatch(/OneDrive.*task IEAGIITR.*queried with withUrls: true.*returned no URL.*Wrike directly/s);
    expect(caught?.message).not.toMatch(/try list_attachments/i);
  });

  it("get_attachment with mode: 'download' surfaces Wrike's 'URL method only' 400 by pointing at mode: 'url'", async () => {
    const client = mockClient();
    (client.getBinary as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new WrikeApiError(400, 'invalid_request', 'Wrike API error 400 (invalid_request): Attachment can be accessed via URL method only')
    );
    await expect(
      byName('get_attachment').handler(client, { attachmentId: 'IEAGIITRIMFWG6YH', mode: 'download' })
    ).rejects.toThrow(/mode: 'url'/);
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
