import type { Express } from 'express';
import { loadConfig } from './config.js';
import { AuthManager } from './auth/authManager.js';
import { AttachmentLinks } from './auth/attachmentLinks.js';
import { EncryptedTokenStore } from './secrets/tokenStore.js';
import { WrikeClient } from './wrikeClient.js';
import { buildTools } from './tools/toolDefinitions.js';
import { createToolRegistry } from './tools/toolRegistry.js';
import { createMcpServer } from './server.js';
import { createHttpApp } from './httpServer.js';
import { SessionManager } from './transport.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new EncryptedTokenStore(config.tokenEncryptionKey, config.tokenStorePath);
  const authManager = new AuthManager(config.auth, store);

  const registry = createToolRegistry(buildTools());

  // Signed get_attachment mode:'url' links, only available once this server
  // knows its own public origin; undefined leaves signedDownloadUrl throwing
  // a clear error rather than emitting a broken/relative URL.
  const links = config.publicBaseUrl
    ? new AttachmentLinks(config.tokenEncryptionKey, config.publicBaseUrl)
    : undefined;

  // Each MCP session is bound to one user; tools run against that user's
  // Wrike credentials only.
  const sessionManager = new SessionManager((userId) =>
    createMcpServer(registry, new WrikeClient(authManager, userId, fetch, links))
  );

  const app: Express = createHttpApp({ config, authManager, sessionManager, links });

  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Wrike MCP server listening on http://${config.host}:${config.port} (mode: ${config.auth.mode})`
    );
  });

  const shutdown = () => {
    sessionManager.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});