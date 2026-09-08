import { z } from 'zod';
import type { ToolDefinition } from './toolDefinitions.js';
import type { WrikeClient } from '../wrikeClient.js';
import type { UserId } from '../auth/authManager.js';

/** Tool surface exposed to MCP clients. */
export interface Tool {
  name: string;
  description: string;
  /** Zod raw shape — the form the MCP SDK expects for tool input schemas. */
  inputSchema: z.ZodRawShape;
  /** Validates input and runs the tool with a client bound to the requesting user. */
  handler: (client: WrikeClient, input: unknown) => Promise<unknown>;
}

export interface ToolRegistry {
  list(): Tool[];
  get(name: string): Tool | undefined;
}

export function createToolRegistry(defs: ToolDefinition[]): ToolRegistry {
  const tools: Tool[] = defs.map((d) => {
    const schema = d.inputSchema;
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(`Tool ${d.name}: expected a zod object schema`);
    }
    return {
      name: d.name,
      description: d.description,
      inputSchema: schema.shape as z.ZodRawShape,
      handler: d.handler as Tool['handler'],
    };
  });
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => tools,
    get: (name) => map.get(name),
  };
}

export type { UserId };