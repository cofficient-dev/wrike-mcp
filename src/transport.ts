import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';

export interface UserSession {
  sessionId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * Manages per-user MCP sessions.
 *
 * Each MCP client session (identified by its connection token on the first
 * request) gets a dedicated McpServer instance whose tools use that user's
 * Wrike credentials. Sessions are reused via the `mcp-session-id` header.
 */
export class SessionManager {
  private sessions = new Map<string, UserSession>();

  constructor(
    /** Creates a fresh McpServer bound to the given user's credentials. */
    private readonly createServerForUser: (userId: string) => McpServer
  ) {}

  /** Returns the existing session for a client-supplied id, if any. */
  get(sessionId: string | undefined): UserSession | undefined {
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /** Creates a new session bound to a user. */
  async create(userId: string): Promise<UserSession> {
    const sessionId = randomUUID();
    const server = this.createServerForUser(userId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: false,
    });
    transport.onclose = () => {
      this.sessions.delete(sessionId);
    };
    await server.connect(transport);
    const session: UserSession = { sessionId, server, transport };
    this.sessions.set(sessionId, session);
    return session;
  }

  async handleRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let session = this.get(sessionId);
    if (!session) {
      // New session — the HTTP layer has already authenticated req and stored
      // the resolved user ID; see httpServer.ts.
      const userId = (req as Request & { resolvedUserId?: string }).resolvedUserId;
      if (!userId) {
        throw new Error('unauthenticated session');
      }
      session = await this.create(userId);
      res.setHeader('mcp-session-id', session.sessionId);
    }
    await session.transport.handleRequest(req, res, req.body);
  }

  closeAll(): void {
    for (const s of this.sessions.values()) {
      void s.transport.close();
    }
    this.sessions.clear();
  }
}

/**
 * Backwards-compatible helper retained for tests.
 */
export async function startTransport(mcpServer: McpServer): Promise<(req: Request, res: Response) => Promise<void>> {
  const sessions = new SessionManager(() => mcpServer);
  return (req, res) => sessions.handleRequest(req, res);
}