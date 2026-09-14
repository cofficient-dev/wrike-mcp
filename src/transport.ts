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
      if (sessionId) {
        // The client sent an mcp-session-id, but nothing here matches it.
        // Sessions live only in the in-memory `sessions` map above, so every
        // restart (i.e. every deploy) discards them all without telling any
        // connected client. Its next request still carries the old id, and
        // this used to fall through to the "new session" branch below: a
        // fresh session got created for whatever request the client actually
        // sent — typically tools/call, not initialize — and handed to a
        // transport that was never initialized, so it could not succeed. The
        // client never received the one signal that would tell it to
        // recover, and was left reporting "session expired" until a human
        // disconnected and reconnected it by hand.
        //
        // The spec (Streamable HTTP, Session Management) is explicit about
        // the fix:
        //   3. The server MAY terminate the session at any time, after which
        //      it MUST respond to requests containing that session ID with
        //      HTTP 404 Not Found.
        //   4. When a client receives HTTP 404 in response to a request
        //      containing an Mcp-Session-Id, it MUST start a new session by
        //      sending a new InitializeRequest without a session ID attached.
        // Sending 404 here — instead of silently creating a session — is what
        // makes that mandatory client-side recovery path actually trigger, so
        // the client reinitializes itself within a second or two instead of
        // needing manual intervention.
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found or expired. Reinitialize the connection with a new InitializeRequest.',
          },
          id: null,
        });
        return;
      }
      // No mcp-session-id header at all — this is the initialization case,
      // unrelated to the above. The HTTP layer has already authenticated req
      // and stored the resolved user ID; see httpServer.ts.
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