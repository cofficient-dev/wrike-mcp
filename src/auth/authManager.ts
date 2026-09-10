import type { StoredUserTokens } from '../secrets/tokenStore.js';
import { refreshTokens, toStoredTokens, OAuthTokenResponse } from './oauth.js';
import type { EncryptedTokenStore } from '../secrets/tokenStore.js';
import type { PatConfig, OAuthConfig } from '../config.js';

/**
 * Per-user authentication manager.
 *
 *  - pat:   one configured permanent token (single-user mode, clearly labeled).
 *  - oauth: every user authorizes via the /connect flow; each user's Wrike
 *           tokens are stored encrypted under their user ID. Refresh is
 *           single-flight **per user** (Wrike rotates refresh tokens, so
 *           concurrent refreshes for the same user would invalidate each
 *           other's refresh tokens).
 *
 * Wrike tokens never leave this module except into the Wrike client's
 * Authorization header; they are never logged or returned to callers.
 */
export class AuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthError';
    }
}

export type UserId = string;

interface UserState {
    tokens: StoredUserTokens;
    refreshInFlight?: Promise<StoredUserTokens>;
}

export class AuthManager {
    private users = new Map<UserId, UserState>();
    private initialized?: Promise<void>;

    constructor(
        public readonly auth: PatConfig | OAuthConfig,
        private readonly store: EncryptedTokenStore,
        private readonly now: () => number = Date.now,
        private readonly fetchImpl: typeof fetch = fetch
    ) { }

    get authMode(): 'pat' | 'oauth' {
        return this.auth.mode;
    }

    // ------------------------------------------------------------------ boot

    /** Loads all stored users into memory (encrypted file -> memory only). */
    private async loadInitial(): Promise<void> {
        this.initialized ??= (async () => {
            for (const [userId, rec] of Object.entries((await this.store.read())?.users ?? {})) {
                if (rec.tokens) this.users.set(userId, { tokens: rec.tokens });
            }
        })();
        await this.initialized;
    }


    // --------------------------------------------------------------- PAT mode

    /** PAT mode: the single configured user id. */
    static readonly PAT_USER_ID = '__pat__';

    private patConfig(): PatConfig {
        if (this.auth.mode !== 'pat') throw new AuthError('not in pat mode');
        return this.auth;
    }

    async hasCredentials(userId: UserId = AuthManager.PAT_USER_ID): Promise<boolean> {
        if (this.auth.mode === 'pat') return userId === AuthManager.PAT_USER_ID;
        await this.loadInitial();
        return this.users.has(userId);
    }

    async getStatus(userId: UserId = AuthManager.PAT_USER_ID): Promise<'authenticated' | 'needs_authorization'> {
        return (await this.hasCredentials(userId)) ? 'authenticated' : 'needs_authorization';
    }

    async listUsers(): Promise<UserId[]> {
        if (this.auth.mode === 'pat') return [AuthManager.PAT_USER_ID];
        await this.loadInitial();
        return [...this.users.keys()];
    }

    // -------------------------------------------------------------- OAuth mode

    /** Completes the /connect flow for a user: stores their Wrike tokens. */
    async storeUserTokens(userId: UserId, tokens: StoredUserTokens): Promise<void> {
        if (this.auth.mode !== 'oauth') throw new AuthError('storeUserTokens is only valid in oauth mode');
        this.users.set(userId, { tokens });
        await this.store.saveUserTokens(userId, tokens);
    }

    /**
     * Claims a user slot only if it is free, returning false if it is taken.
     *
     * Tokens are stored by handle and storeUserTokens overwrites, so two
     * browsers completing Wrike consent for the same handle would leave the
     * later one's tokens under it — repointing every connection token already
     * issued for that handle at the other person's Wrike account. The check
     * and the claim run with no await between them, so on Node's single
     * thread they cannot interleave.
     */
    async storeUserTokensIfAbsent(userId: UserId, tokens: StoredUserTokens): Promise<boolean> {
        if (this.auth.mode !== 'oauth') throw new AuthError('storeUserTokens is only valid in oauth mode');
        await this.loadInitial();
        if (this.users.has(userId)) return false;
        this.users.set(userId, { tokens });
        await this.store.saveUserTokens(userId, tokens);
        return true;
    }

    /** Issues a one-time connection token for a user (persisted as hash only). */
    async issueConnectionToken(userId: UserId): Promise<string> {
        if (this.auth.mode !== 'oauth') throw new AuthError('connection tokens are only valid in oauth mode');
        await this.loadInitial();
        const state = this.users.get(userId);
        if (!state) throw new AuthError(`unknown user: ${userId}`);
        return this.store.addConnectionToken(userId, state.tokens);
    }

    /** Resolves an incoming connection token to a user ID. */
    async resolveConnectionToken(token: string): Promise<UserId | undefined> {
        if (this.auth.mode !== 'oauth') return undefined;
        return this.store.resolveConnectionToken(token);
    }

    /** Removes a user and all their tokens (self-service revoke). */
    async revokeUser(userId: UserId): Promise<void> {
        this.users.delete(userId);
        await this.store.deleteUser(userId);
    }

    // ----------------------------------------------------------------- tokens

    /** Returns a valid access token for the user, refreshing first if near expiry. */
    async getAccessToken(userId: UserId = AuthManager.PAT_USER_ID): Promise<string> {
        if (this.auth.mode === 'pat') {
            if (userId !== AuthManager.PAT_USER_ID) throw new AuthError('pat mode has a single user');
            return this.patConfig().pat;
        }
        await this.loadInitial();
        let state = this.users.get(userId);
        if (!state) throw new AuthError('user is not authorized: complete /connect first');
        if (this.now() >= state.tokens.expiresAtMs - 60_000) {
            state = { tokens: await this.refresh(userId) };
        }
        return state.tokens.accessToken;
    }

    /** Wrike data-center host for the user (from their token response or config). */
    async getHost(userId: UserId = AuthManager.PAT_USER_ID): Promise<string> {
        if (this.auth.mode === 'pat') return this.patConfig().host;
        await this.loadInitial();
        return this.users.get(userId)?.tokens.host ?? 'www.wrike.com';
    }

    /**
     * Single-flight refresh **per user**. Wrike invalidates the old refresh
     * token when a new one is issued, so concurrent refresh calls for the same
     * user must be collapsed into one — while different users refresh independently.
     */
    async refresh(userId: UserId = AuthManager.PAT_USER_ID): Promise<StoredUserTokens> {
        if (this.auth.mode !== 'oauth') throw new AuthError('refresh is only valid in oauth mode');
        await this.loadInitial();
        const state = this.users.get(userId);
        if (!state) throw new AuthError('user is not authorized: complete /connect first');
        if (state.refreshInFlight) return state.refreshInFlight;
        state.refreshInFlight = this.doRefresh(userId, state.tokens).finally(() => {
            state.refreshInFlight = undefined;
        });
        return state.refreshInFlight;
    }

    private async doRefresh(userId: UserId, current: StoredUserTokens): Promise<StoredUserTokens> {
        if (this.auth.mode !== 'oauth') throw new AuthError('refresh is only valid in oauth mode');
        if (!current.refreshToken) throw new AuthError('cannot refresh: no refresh token stored');
        const resp: OAuthTokenResponse = await refreshTokens(this.auth, current.refreshToken, this.fetchImpl);
        const next = toStoredTokens(resp, current.host);
        await this.storeUserTokens(userId, next);
        return next;
    }
}