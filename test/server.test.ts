import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../src/server.js';
import type { ToolRegistry, Tool } from '../src/tools/toolRegistry.js';
import type { WrikeClient } from '../src/wrikeClient.js';

function registryOf(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { list: () => tools, get: (name) => map.get(name) };
}

function makeTool(name: string, handler: Tool['handler']): Tool {
  return { name, description: 'test tool', inputSchema: {}, handler };
}

type Callback = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * createMcpServer's own result-wrapping logic lives inside the callback it
 * hands to McpServer.tool() for each registered tool. Spying on tool() is the
 * least invasive way to get at that callback without standing up a real
 * transport: it captures the callback McpServer would otherwise have called
 * on an actual tools/call request.
 */
function captureCallbacks(registry: ToolRegistry, client: WrikeClient): Map<string, Callback> {
  const captured = new Map<string, Callback>();
  const spy = vi
    .spyOn(McpServer.prototype, 'tool')
    .mockImplementation(function (this: McpServer, name: string, ...rest: unknown[]) {
      captured.set(name, rest[rest.length - 1] as Callback);
      return {} as ReturnType<McpServer['tool']>;
    });
  createMcpServer(registry, client);
  spy.mockRestore();
  return captured;
}

const client = {} as WrikeClient;

describe('createMcpServer tool result wrapping', () => {
  it('passes __mcpContent blocks through unchanged instead of stringifying them', async () => {
    const blocks = [{ type: 'text' as const, text: 'hello' }];
    const registry = registryOf([makeTool('t', async () => ({ __mcpContent: blocks }))]);
    const result = await captureCallbacks(registry, client).get('t')!({});
    expect(result).toEqual({ content: blocks, isError: false });
  });

  it('still JSON-stringifies an ordinary object result, unchanged from before', async () => {
    const value = { id: 'X', count: 2 };
    const registry = registryOf([makeTool('t', async () => value)]);
    const result = await captureCallbacks(registry, client).get('t')!({});
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      isError: false,
    });
  });

  it('does not mistake a result that legitimately has its own "content" field for the marker', async () => {
    // A tool result can legitimately have its own `content` field, no
    // `__mcpContent`. Keying detection on `content` would misread this as
    // content blocks; it must still be stringified.
    const value = {
      attachmentId: 'A1',
      contentType: 'application/pdf',
      size: 3,
      encoding: 'base64',
      content: 'QUJD',
      note: 'not a real get_attachment result any more, just a shape check',
    };
    const registry = registryOf([makeTool('t', async () => value)]);
    const result = await captureCallbacks(registry, client).get('t')!({});
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      isError: false,
    });
  });

  it('leaves the error path unchanged', async () => {
    const registry = registryOf([
      makeTool('t', async () => {
        throw new Error('boom');
      }),
    ]);
    const result = await captureCallbacks(registry, client).get('t')!({});
    expect(result).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });
});
