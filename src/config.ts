import { z } from 'zod';

const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)');

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  AUTH_MODE: z.enum(['pat', 'oauth']).optional(),
  WRIKE_PAT: z.string().min(1).optional(),
  WRIKE_HOST: z.string().min(1).optional(),
  WRIKE_CLIENT_ID: z.string().min(1).optional(),
  WRIKE_CLIENT_SECRET: z.string().min(1).optional(),
  WRIKE_REDIRECT_URI: z.string().url().optional(),
  WRIKE_SCOPES: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: hex64,
  TOKEN_STORE_PATH: z.string().default('data/tokens.json'),
});

export interface PatConfig {
  mode: 'pat';
  pat: string;
  host: string;
}

export interface OAuthConfig {
  mode: 'oauth';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export type AuthConfig = PatConfig | OAuthConfig;

export interface AppConfig {
  port: number;
  host: string;
  auth: AuthConfig;
  tokenEncryptionKey: Buffer;
  tokenStorePath: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  let auth: AuthConfig | undefined;
  const mode = e.AUTH_MODE ?? (e.WRIKE_PAT ? 'pat' : e.WRIKE_CLIENT_ID ? 'oauth' : undefined);

  if (mode === 'pat') {
    if (!e.WRIKE_PAT) throw new ConfigError('AUTH_MODE=pat requires WRIKE_PAT');
    auth = { mode: 'pat', pat: e.WRIKE_PAT, host: e.WRIKE_HOST ?? 'www.wrike.com' };
  } else if (mode === 'oauth') {
    const missing = (['WRIKE_CLIENT_ID', 'WRIKE_CLIENT_SECRET', 'WRIKE_REDIRECT_URI'] as const).filter(
      (k) => !e[k]
    );
    if (missing.length > 0) {
      throw new ConfigError(`AUTH_MODE=oauth requires ${missing.join(', ')}`);
    }
    auth = {
      mode: 'oauth',
      clientId: e.WRIKE_CLIENT_ID!,
      clientSecret: e.WRIKE_CLIENT_SECRET!,
      redirectUri: e.WRIKE_REDIRECT_URI!,
      scopes: (e.WRIKE_SCOPES ?? 'Default').split(',').map((s) => s.trim()).filter(Boolean),
    };
  } else {
    throw new ConfigError(
      'No authentication configured: set WRIKE_PAT (pat mode) or WRIKE_CLIENT_ID/WRIKE_CLIENT_SECRET/WRIKE_REDIRECT_URI (oauth mode)'
    );
  }

  return {
    port: e.PORT,
    host: e.HOST,
    auth,
    tokenEncryptionKey: Buffer.from(e.TOKEN_ENCRYPTION_KEY, 'hex'),
    tokenStorePath: e.TOKEN_STORE_PATH,
  };
}