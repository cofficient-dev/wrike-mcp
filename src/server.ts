import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from './tools/toolRegistry.js';
import type { WrikeClient } from './wrikeClient.js';
import { WrikeApiError } from './wrikeClient.js';

/**
 * Wrike MCP server. Each authenticated session gets its own McpServer
 * instance whose tools run against a WrikeClient bound to that user's
 * credentials — users only ever see their own Wrike data. Errors are
 * converted to MCP tool errors without leaking secrets.
 */
export function createMcpServer(
  registry: ToolRegistry,
  client: WrikeClient,
  serverInfo: { name: string; version: string } = { name: 'wrike-mcp', version: '0.1.0' }
): McpServer {
  const server = new McpServer(
    { name: serverInfo.name, version: serverInfo.version },
    { capabilities: { tools: {} } }
  );

  for (const tool of registry.list()) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const result = await tool.handler(client, args);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: errorMessage(err) }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
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