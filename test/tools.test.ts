import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../src/tools/toolDefinitions.js';
import type { WrikeClient } from '../src/wrikeClient.js';

function mockClient() {
  return {
    get: vi.fn().mockResolvedValue({ kind: 'ok', data: [] }),
    post: vi.fn().mockResolvedValue({ kind: 'ok', data: [{ id: 'X' }] }),
    put: vi.fn().mockResolvedValue({ kind: 'ok', data: [{ id: 'X' }] }),
    delete: vi.fn().mockResolvedValue({ kind: 'ok', data: [] }),
    upload: vi.fn().mockResolvedValue({ kind: 'attachments', data: [{ id: 'ATT' }] }),
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
});