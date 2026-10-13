import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolRegistry, McpContentResult } from './tools/toolRegistry.js';
import type { WrikeClient } from './wrikeClient.js';
import { redact, errorMessage } from './redact.js';

function isMcpContentResult(value: unknown): value is McpContentResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).__mcpContent)
  );
}

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
      async (args: Record<string, unknown>): Promise<CallToolResult> => redactResult(await runTool(tool, client, args))
    );
  }

  return server;
}

async function runTool(
  tool: Tool,
  client: WrikeClient,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const result = await tool.handler(client, args);
    if (isMcpContentResult(result)) {
      return { content: result.__mcpContent, isError: false };
    }
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

/**
 * The single redaction boundary for MCP tool results, success and error
 * alike: a success result can carry upstream error text too (search folds
 * it in), and everything here reaches the model and its transcript.
 * Only text blocks are scrubbed; binary blocks (images) are not text.
 */
function redactResult(result: CallToolResult): CallToolResult {
  return {
    ...result,
    content: result.content.map((c) => (c.type === 'text' ? { ...c, text: redact(c.text) } : c)),
  };
}
