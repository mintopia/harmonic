import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, notInArray, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
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

  constructor(private readonly db: Db) {}

  // ---- Operator password ----

  hasPassword(): boolean {
    return this.readAuth() !== null;
  }

  setPassword(password: string): void {
    if (password.length < 4) throw new DomainError('validation', 'password too short');
    const salt = randomBytes(16).toString('hex');
    const value = JSON.stringify({ salt, hash: hashPassword(password, salt) } satisfies StoredAuth);
    this.db
      .insert(settings)
      .values({ key: AUTH_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  verifyLogin(password: string): boolean {
    const stored = this.readAuth();
    if (!stored) return false;
    const candidate = Buffer.from(hashPassword(password, stored.salt), 'hex');
    const expected = Buffer.from(stored.hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private readAuth(): StoredAuth | null {
    const row = this.db.select().from(settings).where(eq(settings.key, AUTH_KEY)).get();
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

  // ---- API keys ----

  createKey(name: string, opts: { scope?: 'full' | 'run'; runId?: number } = {}): { key: ApiKeyRow; token: string } {
    const token = KEY_PREFIX + randomBytes(24).toString('hex');
    const key = this.db
      .insert(apiKeys)
      .values({
        name,
        tokenHash: hashToken(token),
        prefix: token.slice(0, KEY_PREFIX.length + 8),
        scope: opts.scope ?? 'full',
        runId: opts.runId ?? null,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return { key, token };
  }

  /** Validate a bearer token; touches last-used. Returns null when invalid or revoked. */
  verifyKey(token: string): ApiKeyRow | null {
    if (!token.startsWith(KEY_PREFIX)) return null;
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.tokenHash, hashToken(token))).get();
    if (!row || row.revokedAt !== null) return null;
    this.db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run();
    return row;
  }

  /** Operator API Keys only — Run Keys are machine credentials, never listed. */
  listKeys(): Omit<ApiKeyRow, 'tokenHash'>[] {
    return this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.scope, 'full'))
      .orderBy(desc(apiKeys.createdAt))
      .all()
      .map(({ tokenHash: _hash, ...rest }) => rest);
  }

  revokeKey(id: number): void {
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
    if (!row) throw new DomainError('not_found', `api key ${id} not found`);
    if (row.revokedAt === null) {
      this.db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, id)).run();
    }
  }

  /** Run Keys die with their Run — hard delete; the Run itself is the audit record. */
  deleteKeysForRun(runId: number): void {
    this.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.scope, 'run'), eq(apiKeys.runId, runId)))
      .run();
  }

  /** Boot-time sweep: delete every Run Key whose Run is no longer running. */
  sweepOrphanedRunKeys(): void {
    const runningRuns = this.db.select({ id: runs.id }).from(runs).where(eq(runs.state, 'running'));
    this.db
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.scope, 'run'),
          or(isNull(apiKeys.runId), notInArray(apiKeys.runId, runningRuns)),
        ),
      )
      .run();
  }

  // ---- Config-repo portability ----

  exportAuth(): StoredAuth | null {
    return this.readAuth();
  }

  importAuth(stored: StoredAuth): void {
    const value = JSON.stringify(stored);
    this.db
      .insert(settings)
      .values({ key: AUTH_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  /** Active full-scope keys, hashes included — the token itself is never known here. */
  exportKeys(): { name: string; tokenHash: string; prefix: string }[] {
    return this.db
      .select()
      .from(apiKeys)
      .all()
      .filter((k) => k.scope === 'full' && k.revokedAt === null)
      .map(({ name, tokenHash, prefix }) => ({ name, tokenHash, prefix }));
  }

  importKeys(keys: { name: string; tokenHash: string; prefix: string }[]): void {
    for (const key of keys) {
      const existing = this.db.select().from(apiKeys).where(eq(apiKeys.tokenHash, key.tokenHash)).get();
      if (existing) continue;
      this.db
        .insert(apiKeys)
        .values({ ...key, scope: 'full', runId: null, createdAt: Date.now() })
        .run();
    }
  }
}

export type { StoredAuth };
