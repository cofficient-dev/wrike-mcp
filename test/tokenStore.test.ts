import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  encrypt,
  decrypt,
  EncryptedTokenStore,
  SecretStoreError,
  generateConnectionToken,
  connectionTokenHash,
  safeEqualHex,
} from '../src/secrets/tokenStore.js';

const key = randomBytes(32);

describe('AES-256-GCM encrypt/decrypt', () => {
  it('round-trips plaintext', () => {
    const blob = encrypt(key, '{"secret":"value"}');
    expect(decrypt(key, blob)).toBe('{"secret":"value"}');
  });

  it('produces ciphertext that does not contain the plaintext', () => {
    const blob = encrypt(key, 'SUPER-SECRET-TOKEN');
    expect(blob.toString('utf8')).not.toContain('SUPER-SECRET-TOKEN');
  });

  it('tampering with the ciphertext fails authentication', () => {
    const blob = encrypt(key, 'data');
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(key, blob)).toThrow(SecretStoreError);
  });

  it('rejects a wrong key', () => {
    const blob = encrypt(key, 'data');
    expect(() => decrypt(randomBytes(32), blob)).toThrow(SecretStoreError);
  });

  it('rejects a truncated blob', () => {
    expect(() => decrypt(key, Buffer.alloc(4))).toThrow(SecretStoreError);
  });
});

describe('connection tokens', () => {
  it('generates wmc_-prefixed opaque tokens', () => {
    const t = generateConnectionToken();
    expect(t).toMatch(/^wmc_[A-Za-z0-9\-_]{40,}$/);
    expect(t).not.toBe(generateConnectionToken());
  });

  it('hashes are key-dependent (different keys -> different hashes)', () => {
    const t = generateConnectionToken();
    expect(connectionTokenHash(key, t)).not.toBe(connectionTokenHash(randomBytes(32), t));
  });

  it('safeEqualHex is constant-shape and rejects mismatches', () => {
    const h = connectionTokenHash(key, 'x');
    expect(safeEqualHex(h, connectionTokenHash(key, 'x'))).toBe(true);
    expect(safeEqualHex(h, connectionTokenHash(key, 'y'))).toBe(false);
    expect(safeEqualHex(h, '')).toBe(false);
  });
});

describe('EncryptedTokenStore (multi-user)', () => {
  let dir: string;
  let path: string;
  let store: EncryptedTokenStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'wrike-mcp-test-'));
    path = join(dir, 'nested', 'tokens.json');
    store = new EncryptedTokenStore(key, path);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when no store exists yet', async () => {
    expect(await store.read()).toBeUndefined();
  });

  it('saves and loads multiple users independently', async () => {
    await store.saveUserTokens('alice', { accessToken: 'AT-A', refreshToken: 'RT-A', expiresAtMs: 1, host: 'www.wrike.com' });
    await store.saveUserTokens('bob', { accessToken: 'AT-B', refreshToken: 'RT-B', expiresAtMs: 2, host: 'app-eu.wrike.com' });
    const reloaded = new EncryptedTokenStore(key, path);
    expect((await reloaded.getUserTokens('alice'))!.accessToken).toBe('AT-A');
    expect((await reloaded.getUserTokens('bob'))!.host).toBe('app-eu.wrike.com');
    expect(await reloaded.getUserTokens('carol')).toBeUndefined();
    expect((await reloaded.listUserIds()).sort()).toEqual(['alice', 'bob']);
  });

  it('raw file bytes never contain any token', async () => {
    await store.saveUserTokens('alice', { accessToken: 'PLAINTEXT-LEAK-CHECK', refreshToken: 'RT', expiresAtMs: 1, host: 'h' });
    const raw = await fs.readFile(path);
    expect(raw.toString('utf8')).not.toContain('PLAINTEXT-LEAK-CHECK');
  });

  it('connection token plaintext never touches disk (hash only)', async () => {
    await store.saveUserTokens('alice', { accessToken: 'AT', refreshToken: 'RT', expiresAtMs: 1, host: 'h' });
    const ct = await store.addConnectionToken('alice', { accessToken: 'AT', refreshToken: 'RT', expiresAtMs: 1, host: 'h' });
    const raw = (await fs.readFile(path)).toString('utf8');
    expect(raw).not.toContain(ct);
    // But it resolves.
    expect(await store.resolveConnectionToken(ct)).toBe('alice');
  });

  it('updating a user preserves their connection tokens', async () => {
    await store.saveUserTokens('alice', { accessToken: 'AT', refreshToken: 'RT', expiresAtMs: 1, host: 'h' });
    const ct = await store.addConnectionToken('alice', { accessToken: 'AT', refreshToken: 'RT', expiresAtMs: 1, host: 'h' });
    await store.saveUserTokens('alice', { accessToken: 'AT2', refreshToken: 'RT2', expiresAtMs: 2, host: 'h' });
    expect(await store.resolveConnectionToken(ct)).toBe('alice');
    expect((await store.getUserTokens('alice'))!.accessToken).toBe('AT2');
  });

  it('deleteUser removes only that user', async () => {
    await store.saveUserTokens('alice', { accessToken: 'A', refreshToken: 'R', expiresAtMs: 1, host: 'h' });
    await store.saveUserTokens('bob', { accessToken: 'B', refreshToken: 'R', expiresAtMs: 1, host: 'h' });
    await store.deleteUser('alice');
    expect(await store.getUserTokens('alice')).toBeUndefined();
    expect((await store.getUserTokens('bob'))!.accessToken).toBe('B');
  });

  it('file is created with 0600 permissions', async () => {
    await store.write({ users: {} });
    const stat = await fs.stat(path);
    // POSIX permission bit check; on Windows mode is 0o666, so only assert existence.
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('clear removes the file', async () => {
    await store.write({ users: {} });
    await store.clear();
    expect(await store.read()).toBeUndefined();
  });

  it('rejects a store written with a different key (tamper detection)', async () => {
    await store.saveUserTokens('alice', { accessToken: 'A', refreshToken: 'R', expiresAtMs: 1, host: 'h' });
    const wrongKey = new EncryptedTokenStore(randomBytes(32), path);
    await expect(wrongKey.read()).rejects.toThrow(SecretStoreError);
  });
});