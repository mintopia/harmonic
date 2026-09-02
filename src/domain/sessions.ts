import { and, eq, isNotNull, ne } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { sessions, type SessionRow, type SessionRetireReason } from '../db/schema.js';
import type { AcpInitializeResult } from '../acp/driver.js';
import { DomainError } from './errors.js';
import { canTransition, isRetentionElapsed } from './session-retirement.js';
import { startOperation } from '../telemetry/operations.js';

const CREDENTIAL_KEYS = new Set([
  'headers',
  'env',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'bearer',
  'password',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'cookie',
  'auth',
]);

/**
 * Strip every credential-bearing field from a `session/new` mcpServers list,
 * yielding the credential-free templates a Session stores. Recurses into
 * nested objects/arrays and drops any key in {@link CREDENTIAL_KEYS}
 * (case-insensitive). A non-array input yields `[]`.
 */
export function stripMcpCredentials(servers: unknown): unknown[] {
  if (!Array.isArray(servers)) return [];
  return servers.map((s) => redact(s));
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEYS.has(key.toLowerCase())) continue;
      out[key] = redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Re-attach freshly-minted credentials to the credential-free MCP templates a
 * Session stored, producing the `session/load` mcpServers for a resume. An
 * `http` server gets its `Authorization: Bearer <token>` header re-added;
 * other entries pass through unchanged. A non-array input yields `[]`.
 */
export function graftMcpCredentials(templates: unknown, token: string): unknown[] {
  if (!Array.isArray(templates)) return [];
  return templates.map((s) => {
    if (s && typeof s === 'object' && !Array.isArray(s) && (s as { type?: unknown }).type === 'http') {
      return { ...(s as Record<string, unknown>), headers: [{ name: 'Authorization', value: `Bearer ${token}` }] };
    }
    return s;
  });
}

/** Whether the harness advertised `session/load` support in its `initialize` result; anything but `true` reads as unsupported. */
export function readLoadSessionCapability(result: AcpInitializeResult | undefined): boolean {
  return result?.agentCapabilities?.loadSession === true;
}

/** Everything {@link SessionStore.recordDispatch} needs to persist a Session on
 * dispatch. `capabilities` is the raw `initialize` result; `mcpTemplates` is
 * the credentialed `session/new` mcpServers list — the store strips secrets
 * before persisting. */
export interface DispatchSessionInput {
  harness: string;
  harnessSessionId: string;
  model: string;
  cwd: string;
  workspaceId: number | null;
  /** Absolute native transcript path found at dispatch, or null when absent. */
  transcriptPath?: string | null;
  mcpTemplates: unknown;
  permissionMode?: string | null;
  capabilities: AcpInitializeResult | undefined;
  adapterVersion: string;
  now: number;
}

/**
 * The durable Session store: one ACP conversation with a Harness, keyed
 * uniquely on `(harness, harnessSessionId)`.
 */
export class SessionStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Persist the Session for a dispatch, upserting on `(harness,
   * harnessSessionId)`. A reused harness session refreshes the capability
   * snapshot, model/cwd, templates and `lastActiveAt` and re-marks it `active`.
   * A transiently absent transcript never replaces a path discovered earlier.
   * Credentials are stripped from `mcpTemplates` and never stored.
   */
  async recordDispatch(input: DispatchSessionInput): Promise<SessionRow> {
    const capabilitySnapshot = JSON.stringify(input.capabilities ?? {});
    const supportsLoadSession = readLoadSessionCapability(input.capabilities);
    const mcpTemplates = JSON.stringify(stripMcpCredentials(input.mcpTemplates));
    const operation = startOperation({ type: 'session.create', attributes: { 'session.harness': input.harness } });
    try {
      const session = await operation.run(() =>
        this.db.write(async (db) => {
          const existing = await db
            .select()
            .from(sessions)
            .where(and(eq(sessions.harness, input.harness), eq(sessions.harnessSessionId, input.harnessSessionId)))
            .get();
          if (existing) {
            return (await db
              .update(sessions)
              .set({
                model: input.model,
                cwd: input.cwd,
                workspaceId: input.workspaceId,
                ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
                mcpTemplates,
                ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
                capabilitySnapshot,
                supportsLoadSession,
                adapterVersion: input.adapterVersion,
                status: 'active',
                lastActiveAt: input.now,
                updatedAt: input.now,
              })
              .where(eq(sessions.id, existing.id))
              .returning()
              .get())!;
          }
          return db
            .insert(sessions)
            .values({
              harness: input.harness,
              harnessSessionId: input.harnessSessionId,
              model: input.model,
              cwd: input.cwd,
              workspaceId: input.workspaceId,
              transcriptPath: input.transcriptPath ?? null,
              mcpTemplates,
              permissionMode: input.permissionMode ?? null,
              capabilitySnapshot,
              supportsLoadSession,
              adapterVersion: input.adapterVersion,
              status: 'active',
              lastActiveAt: input.now,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning()
            .get();
        }),
      );
      operation.update({ 'session.id': session.id, 'session.supports-load': session.supportsLoadSession });
      operation.end();
      return session;
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Record the ACP permission mode once it is set on the Session. */
  async setPermissionMode(id: number, permissionMode: string, now: number): Promise<SessionRow> {
    return (await this.db.write((db) =>
      db
        .update(sessions)
        .set({ permissionMode, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
    ))!;
  }

  /** Record a native transcript discovered after the harness has flushed it. */
  async setTranscriptPath(id: number, transcriptPath: string, now: number): Promise<SessionRow> {
    return (await this.db.write((db) =>
      db
        .update(sessions)
        .set({ transcriptPath, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
    ))!;
  }

  /** Record, on the original Session, why a `session/load` reload was declined
   * and a fresh summarized Session was minted in its place. */
  async recordResumeIncompatibility(id: number, reason: string, detail: string, now: number): Promise<SessionRow> {
    return (await this.db.write((db) =>
      db
        .update(sessions)
        .set({ resumeIncompatibilityReason: reason, resumeIncompatibilityDetail: detail, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
    ))!;
  }

  async get(id: number): Promise<SessionRow> {
    const row = await this.db.read((db) => db.select().from(sessions).where(eq(sessions.id, id)).get());
    if (!row) throw new DomainError('not_found', `session ${id} not found`);
    return row;
  }

  /** The Session for a harness's own session id, or undefined. */
  async getByHarnessSession(harness: string, harnessSessionId: string): Promise<SessionRow | undefined> {
    return this.db.read((db) =>
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.harness, harness), eq(sessions.harnessSessionId, harnessSessionId)))
        .get(),
    );
  }

  /** Bind the builder worktree this Session owns: the base repo it was carved
   * from and its checkout path, so retirement knows what to remove. Idempotent. */
  async bindWorktree(id: number, worktreeRepoDir: string, worktreePath: string, now: number): Promise<SessionRow> {
    return (await this.db.write((db) =>
      db
        .update(sessions)
        .set({ worktreePath, worktreeRepoDir, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
    ))!;
  }

  /** Move the Session to `idle` under a retention `deadline`, carrying the
   * `reason` the sweep will retire it under. A `null` deadline means retain
   * until the Task's terminal disposition. No-op once already `retiring`/`retired`. */
  async markIdle(id: number, retireDeadline: number | null, reason: SessionRetireReason, now: number): Promise<SessionRow> {
    return this.db.write(async (db) => {
      const row = await db.select().from(sessions).where(eq(sessions.id, id)).get();
      if (!row) throw new DomainError('not_found', `session ${id} not found`);
      if (!canTransition(row.status, 'idle')) return row;
      return (await db
        .update(sessions)
        .set({ status: 'idle', retireDeadline, retireReason: reason, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get())!;
    });
  }

  /** Move the Session to `retiring` — worktree removal is now owed; a crash
   * before `retired` leaves it here for the boot sweep to re-drive. No-op once
   * already `retiring`/`retired`. */
  async beginRetiring(id: number, reason: SessionRetireReason, now: number): Promise<SessionRow> {
    return this.db.write(async (db) => {
      const row = await db.select().from(sessions).where(eq(sessions.id, id)).get();
      if (!row) throw new DomainError('not_found', `session ${id} not found`);
      if (row.status === 'retiring' || row.status === 'retired') return row;
      if (!canTransition(row.status, 'retiring')) return row;
      return (await db
        .update(sessions)
        .set({ status: 'retiring', retireReason: reason, retireDeadline: null, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get())!;
    });
  }

  /** Move the Session to `retired` — its builder worktree has been removed. Terminal; a no-op once already `retired`. */
  async markRetired(id: number, now: number): Promise<SessionRow> {
    return this.db.write(async (db) => {
      const row = await db.select().from(sessions).where(eq(sessions.id, id)).get();
      if (!row) throw new DomainError('not_found', `session ${id} not found`);
      if (row.status === 'retired') return row;
      if (!canTransition(row.status, 'retired')) return row;
      return (await db
        .update(sessions)
        .set({ status: 'retired', retiredAt: now, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get())!;
    });
  }

  /** Reactivate an `idle` Session for a continuation reusing its retained worktree, clearing the retention deadline. No-op if not idle. */
  async reactivate(id: number, now: number): Promise<SessionRow> {
    return this.db.write(async (db) => {
      const row = await db.select().from(sessions).where(eq(sessions.id, id)).get();
      if (!row) throw new DomainError('not_found', `session ${id} not found`);
      if (row.status !== 'idle') return row;
      return (await db
        .update(sessions)
        .set({ status: 'active', retireDeadline: null, retireReason: null, updatedAt: now })
        .where(eq(sessions.id, id))
        .returning()
        .get())!;
    });
  }

  /** Every Session in `retiring` — worktree removal owed. */
  async listRetiring(): Promise<SessionRow[]> {
    return this.db.read((db) => db.select().from(sessions).where(eq(sessions.status, 'retiring')).all());
  }

  /** Every non-retired Session that still owns a builder worktree — the orphan worktree reconcile's exclusion set. */
  async listWorktreeOwners(): Promise<SessionRow[]> {
    return this.db.read((db) => db.select().from(sessions).where(and(isNotNull(sessions.worktreePath), ne(sessions.status, 'retired'))).all());
  }

  /** Every `idle` Session whose retention deadline has lapsed as of `now`. A null deadline never lapses. */
  async listRetentionDue(now: number): Promise<SessionRow[]> {
    return (
      await this.db.read((db) =>
        db
          .select()
          .from(sessions)
          .where(and(eq(sessions.status, 'idle'), isNotNull(sessions.retireDeadline)))
          .all(),
      )
    ).filter((s) => isRetentionElapsed(s, now));
  }
}
