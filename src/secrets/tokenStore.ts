import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Encrypted at-rest token store.
 *
 * Secrets (OAuth access/refresh tokens, PATs) are serialized to JSON and
 * encrypted with AES-256-GCM before hitting disk. The encryption key is
 * supplied via environment and is never written to disk by this module.
 *
 * File layout: [12-byte IV][16-byte auth tag][ciphertext]
 * The auth tag makes any tampering with the ciphertext detectable.
 */
export class SecretStoreError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'SecretStoreError';
    }
}

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function deriveKeyMaterial(key: Buffer): Buffer {
    // Direct 32-byte key is expected; normalize any other length via SHA-256.
    return key.length === 32 ? key : createHash('sha256').update(key).digest();
}

export function encrypt(key: Buffer, plaintext: string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', deriveKeyMaterial(key), iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
    if (blob.length < IV_LENGTH + TAG_LENGTH) {
        throw new SecretStoreError('Token store blob is truncated or corrupt');
    }
    const iv = blob.subarray(0, IV_LENGTH);
    const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', deriveKeyMaterial(key), iv);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw new SecretStoreError('Token store authentication failed: wrong key or tampered file', {
            cause: undefined,
        });
    }
}

/**
 * Per-user OAuth tokens stored inside the encrypted store.
 */
export interface StoredUserTokens {
    accessToken: string;
    refreshToken: string;
    expiresAtMs: number;
    host: string;
}

/**
 * Connection tokens let an MCP client authenticate to this server.
 * They are the *server-local* credential (one per user, shown once);
 * Wrike access/refresh tokens live only inside the encrypted store.
 */
export interface ConnectionTokenRecord {
    /** HMAC-SHA256 of the connection token, keyed by the store key material. */
    tokenHash: string;
    createdAt: number;
}

export interface StoreFileData {
    /** userId -> per-user record */
    users: Record<
        string,
        {
            tokens: StoredUserTokens;
            connectionTokens: ConnectionTokenRecord[];
        }
    >;
}

/** HMAC of a connection token under the store's key material (not reversible from disk). */
export function connectionTokenHash(key: Buffer, token: string): string {
    return createHmac('sha256', deriveKeyMaterial(key)).update(`connection-token:${token}`).digest('hex');
}

/** Constant-time hex digest comparison. */
export function safeEqualHex(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
}

export function generateConnectionToken(): string {
    return `wmc_${randomBytes(32).toString('base64url')}`;
}

export class EncryptedTokenStore {
    /** Serializes all mutations: concurrent writers would race on the tmp file. */
    private writeQueue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly key: Buffer,
        private readonly filePath: string
    ) { }

    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = this.writeQueue.then(job, () => job());
        this.writeQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    async read(): Promise<StoreFileData | undefined> {
        let raw: Buffer;
        try {
            raw = await fs.readFile(this.filePath);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return undefined;
            throw new SecretStoreError(`Cannot read token store: ${code ?? err}`);
        }
        const json = decrypt(this.key, raw);
        try {
            const parsed = JSON.parse(json) as Partial<StoreFileData>;
            if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
            return { users: parsed.users ?? {} };
        } catch {
            throw new SecretStoreError('Token store contains invalid JSON after decryption');
        }
    }

    async write(data: StoreFileData): Promise<void> {
        return this.enqueue(() => this.writeNow(data));
    }

    /** Performs the actual atomic write; callers inside the queue use this directly. */
    private async writeNow(data: StoreFileData): Promise<void> {
        const blob = encrypt(this.key, JSON.stringify(data));
        // Atomic-ish write: temp file + rename so a crash cannot leave a half-written store.
        const tmp = `${this.filePath}.tmp`;
        await fs.mkdir(dirname(this.filePath), { recursive: true });
        await fs.writeFile(tmp, blob, { mode: 0o600 });
        await fs.rename(tmp, this.filePath);
    }

    async clear(): Promise<void> {
        try {
            await fs.unlink(this.filePath);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') throw new SecretStoreError(`Cannot clear token store: ${code ?? err}`);
        }
    }

    // ---------------------------------------------------------------- per-user

    /** Adds/updates a user's Wrike tokens. */
    async saveUserTokens(userId: string, tokens: StoredUserTokens): Promise<void> {
        return this.enqueue(async () => {
            const data = (await this.read()) ?? { users: {} };
            const existing = data.users[userId];
            data.users[userId] = {
                tokens,
                connectionTokens: existing?.connectionTokens ?? [],
            };
            await this.writeNow(data);
        });
    }

    /** Attaches a new connection token (hash) to a user; returns plaintext once. */
    async addConnectionToken(userId: string, tokens: StoredUserTokens): Promise<string> {
        const plaintext = generateConnectionToken();
        await this.enqueue(async () => {
            const data = (await this.read()) ?? { users: {} };
            const existing = data.users[userId];
            data.users[userId] = {
                tokens: existing?.tokens ?? tokens,
                connectionTokens: [
                    ...(existing?.connectionTokens ?? []),
                    { tokenHash: connectionTokenHash(this.key, plaintext), createdAt: Date.now() },
                ],
            };
            await this.writeNow(data);
        });
        return plaintext;
    }

    async getUser(
        userId: string
    ): Promise<{ tokens: StoredUserTokens; connectionTokens: ConnectionTokenRecord[] } | undefined> {
        const data = await this.read();
        return data?.users[userId];
    }

    async getUserTokens(userId: string): Promise<StoredUserTokens | undefined> {
        return (await this.getUser(userId))?.tokens;
    }

    async deleteUser(userId: string): Promise<void> {
        return this.enqueue(async () => {
            const data = await this.read();
            if (data && data.users[userId]) {
                delete data.users[userId];
                await this.writeNow(data);
            }
        });
    }

    async listUserIds(): Promise<string[]> {
        const data = await this.read();
        return data ? Object.keys(data.users) : [];
    }

    /**
     * Resolves a connection token to its user.
     * Scans all records (small N) with constant-time digest comparison.
     */
    async resolveConnectionToken(token: string): Promise<string | undefined> {
        const data = await this.read();
        if (!data) return undefined;
        const want = connectionTokenHash(this.key, token);
        for (const [userId, rec] of Object.entries(data.users)) {
            for (const ct of rec.connectionTokens) {
                if (safeEqualHex(ct.tokenHash, want)) return userId;
            }
        }
        return undefined;
    }
}