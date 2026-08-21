import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { apiKeys, runs, settings, type ApiKeyRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';

const AUTH_KEY = 'auth';
const KEY_PREFIX = 'adk_';

interface StoredAuth {
  salt: string;
  hash: string;
}

const hashPassword = (password: string, salt: string) =>
  scryptSync(password, salt, 64).toString('hex');

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Single-operator auth: one password (scrypt-hashed at rest), in-memory
 * cookie sessions for the SPA, and named revocable bearer API keys for
 * the REST API and MCP server.
 */
export class AuthService {
  private sessions = new Set<string>();

  constructor(private readonly db: AsyncDbHandle) {}

  // ---- Operator password ----

  async hasPassword(): Promise<boolean> {
    return (await this.readAuth()) !== null;
  }

  async setPassword(password: string): Promise<void> {
    if (password.length < 4) throw new DomainError('validation', 'password too short');
    const salt = randomBytes(16).toString('hex');
    const value = JSON.stringify({ salt, hash: hashPassword(password, salt) } satisfies StoredAuth);
    await this.db.write((db) =>
      db
        .insert(settings)
        .values({ key: AUTH_KEY, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run(),
    );
  }

  /** Remove the operator password — Harmonic falls back to ungated. Idempotent. */
  async clearPassword(): Promise<void> {
    await this.db.write((db) => db.delete(settings).where(eq(settings.key, AUTH_KEY)).run());
  }

  async verifyLogin(password: string): Promise<boolean> {
    const stored = await this.readAuth();
    if (!stored) return false;
    const candidate = Buffer.from(hashPassword(password, stored.salt), 'hex');
    const expected = Buffer.from(stored.hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private async readAuth(): Promise<StoredAuth | null> {
    const row = await this.db.read((db) =>
      db.select().from(settings).where(eq(settings.key, AUTH_KEY)).get(),
    );
    return row ? (JSON.parse(row.value) as StoredAuth) : null;
  }

  // ---- Sessions (SPA cookies) ----

  createSession(): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.add(token);
    return token;
  }

  validateSession(token: string | undefined): boolean {
    return token !== undefined && this.sessions.has(token);
  }

  destroySession(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Password changes invalidate every other session (a stolen cookie
   * shouldn't survive a credential rotation) while leaving the caller's own
   * session — `keepToken` — logged in. `undefined` (the caller authenticated
   * some other way, e.g. an API key) destroys all sessions. */
  destroyOtherSessions(keepToken: string | undefined): void {
    for (const token of this.sessions) {
      if (token !== keepToken) this.sessions.delete(token);
    }
  }

  // ---- API keys ----

  async createKey(
    name: string,
    opts: { scope?: 'full' | 'run' | 'conversation' | 'read'; runId?: number; conversationId?: number } = {},
  ): Promise<{ key: ApiKeyRow; token: string }> {
    const token = KEY_PREFIX + randomBytes(24).toString('hex');
    const key = await this.db.write((db) =>
      db
        .insert(apiKeys)
        .values({
          name,
          tokenHash: hashToken(token),
          prefix: token.slice(0, KEY_PREFIX.length + 8),
          scope: opts.scope ?? 'full',
          runId: opts.runId ?? null,
          conversationId: opts.conversationId ?? null,
          createdAt: Date.now(),
        })
        .returning()
        .get(),
    );
    return { key, token };
  }

  /**
   * Validate a bearer token; touches last-used. Returns null when invalid or
   * revoked. The read and the `lastUsedAt` bump are one `write()` unit so the
   * touch has committed by the time the request that authenticated resolves —
   * a caller that immediately re-reads the key (the last-used tracking test)
   * never races the async queue.
   */
  async verifyKey(token: string): Promise<ApiKeyRow | null> {
    if (!token.startsWith(KEY_PREFIX)) return null;
    return this.db.write(async (db) => {
      const row = await db.select().from(apiKeys).where(eq(apiKeys.tokenHash, hashToken(token))).get();
      if (!row || row.revokedAt !== null) return null;
      await db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run();
      return row;
    });
  }

  /** Operator-created API Keys (full + read) — Run/Conversation Keys are machine credentials, never listed. */
  async listKeys(): Promise<Omit<ApiKeyRow, 'tokenHash'>[]> {
    const rows = await this.db.read((db) =>
      db
        .select()
        .from(apiKeys)
        .where(inArray(apiKeys.scope, ['full', 'read']))
        .orderBy(desc(apiKeys.createdAt))
        .all(),
    );
    return rows.map(({ tokenHash: _hash, ...rest }) => rest);
  }

  async revokeKey(id: number): Promise<void> {
    await this.db.write(async (db) => {
      const row = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
      if (!row) throw new DomainError('not_found', `api key ${id} not found`);
      if (row.revokedAt === null) {
        await db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, id)).run();
      }
    });
  }

  /** Run Keys die with their Run — hard delete; the Run itself is the audit record. */
  async deleteKeysForRun(runId: number): Promise<void> {
    await this.db.write((db) =>
      db
        .delete(apiKeys)
        .where(and(eq(apiKeys.scope, 'run'), eq(apiKeys.runId, runId)))
        .run(),
    );
  }

  /** Conversation Keys die with their Conversation — hard delete (issue 16). */
  async deleteKeysForConversation(conversationId: number): Promise<void> {
    await this.db.write((db) =>
      db
        .delete(apiKeys)
        .where(and(eq(apiKeys.scope, 'conversation'), eq(apiKeys.conversationId, conversationId)))
        .run(),
    );
  }

  /** Boot-time sweep: delete every Run Key whose Run is no longer running. */
  async sweepOrphanedRunKeys(): Promise<void> {
    await this.db.write((db) => {
      const runningRuns = db.select({ id: runs.id }).from(runs).where(eq(runs.state, 'running'));
      return db
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.scope, 'run'),
            or(isNull(apiKeys.runId), notInArray(apiKeys.runId, runningRuns)),
          ),
        )
        .run();
    });
  }

  /**
   * Boot-time sweep: delete every Conversation Key (issue 16). A warm
   * Conversation cannot survive a server restart — its harness process is
   * gone — so every conversation-scoped key present at boot is orphaned by
   * definition.
   */
  async sweepOrphanedConversationKeys(): Promise<void> {
    await this.db.write((db) => db.delete(apiKeys).where(eq(apiKeys.scope, 'conversation')).run());
  }
}

export type { StoredAuth };
