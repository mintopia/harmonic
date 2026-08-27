import { and, eq, isNotNull, ne } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { sessions, type SessionRow, type SessionRetireReason } from '../db/schema.js';
import type { AcpInitializeResult } from '../acp/driver.js';
import { DomainError } from './errors.js';
import { canTransition, isRetentionElapsed } from './session-retirement.js';
import { startOperation } from '../telemetry/operations.js';

/**
 * Keys on an MCP server template that can carry a secret. `session/new`
 * mcpServers today are HTTP servers with an `Authorization: Bearer <RunKey>`
 * header, but stdio servers (other harnesses) can carry secrets in `env`, and
 * a token could appear inline — so the credential-free template drops every one
 * of these defensively. Credentials are minted fresh at load/dispatch and
 * grafted back on; they are never persisted (issue #141 acceptance criterion).
 *
 * A deny-list is inherently a best-effort net: it errs toward over-stripping a
 * broad set of known secret-bearing field names so a future harness's server
 * shape can't quietly leak one. `key` is deliberately excluded — too generic a
 * field name to blanket-drop — but its qualified forms (`apiKey`, `api_key`)
 * are covered.
 */
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
 * yielding the durable, credential-free templates a Session stores. Pure and
 * defensive: it recurses into nested objects/arrays and drops any key in
 * {@link CREDENTIAL_KEYS} (case-insensitive) wherever it appears, so a secret
 * nested inside a future server shape can never leak into the DB. Non-object
 * inputs pass through unchanged; a non-array input yields `[]`.
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
 * Session stored, producing the `session/load` mcpServers for a resume. The
 * partial inverse of {@link stripMcpCredentials}: an HTTP MCP server (the
 * `harmonic` server every harness registers over session/new — type `'http'`)
 * gets its `Authorization: Bearer <RunKey>` header re-added from the FRESHLY
 * minted `token`. The credential comes ONLY from `token` (a live mint), never
 * from the stored template (which has none), so a revoked run-scoped key can
 * never be reused on reload (issue #143 acceptance criterion). Non-http / non-
 * object entries pass through unchanged; a non-array input yields `[]`.
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

/**
 * Whether the harness advertised `session/load` support in its `initialize`
 * result (`agentCapabilities.loadSession === true`). Anything else — the flag
 * absent, false, or a legacy driver that surfaced no result — reads as
 * unsupported, so resume never assumes a capability the harness didn't promise.
 */
export function readLoadSessionCapability(result: AcpInitializeResult | undefined): boolean {
  return result?.agentCapabilities?.loadSession === true;
}

/** Per-Harness prompt-cache warm-window estimates in ms — a COST signal, never
 * a correctness TTL. Claude keeps a subscription cache ~1h (`ENABLE_PROMPT_
 * CACHING_1H`); the others have no documented window, so they estimate `null`
 * (unknown) rather than a fake zero. */
const WARM_WINDOW_MS: Record<string, number> = {
  claude: 60 * 60 * 1000,
};

/**
 * Estimated epoch-ms at which `harness`'s prompt cache goes cold, from `now`.
 * `null` when the harness has no known warm window — the absence of an estimate,
 * not a claim that it is instantly cold.
 */
export function estimateWarmUntil(harness: string, now: number): number | null {
  const window = WARM_WINDOW_MS[harness];
  return window === undefined ? null : now + window;
}

/** Everything {@link SessionStore.recordDispatch} needs to persist a Session on
 * dispatch. `capabilities` is the raw `initialize` result (snapshotted whole +
 * mined for `loadSession`); `mcpTemplates` is the *credentialed* `session/new`
 * mcpServers list — the store strips secrets before persisting. */
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
 * The durable Session store (issue #141, reliability-design Unit C). Persists a
 * Session — one ACP conversation with a Harness, a first-class resource — on
 * every dispatch, capturing the harness's `initialize` capability advertisement
 * (previously discarded) and the dispatch identity, keyed uniquely on
 * `(harness, harnessSessionId)`. Written *alongside* Run/Task state, never in
 * place of it. No resume behaviour yet: this is the substrate the rest of Unit
 * C builds on, so the store only records and reads — retirement/load merge later.
 */
export class SessionStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Persist the Session for a dispatch, upserting on `(harness,
   * harnessSessionId)`. A fresh dispatch inserts; a reused harness session
   * (when resume merges) refreshes the capability snapshot, model/cwd, templates
   * and `lastActiveAt` and re-marks it `active`. A transiently absent transcript
   * never replaces a path discovered on an earlier dispatch. Credentials are stripped from
   * `mcpTemplates` and never stored; `capabilitySnapshot` holds the whole
   * `initialize` result and `supportsLoadSession` is mined from it.
   */
  async recordDispatch(input: DispatchSessionInput): Promise<SessionRow> {
    const capabilitySnapshot = JSON.stringify(input.capabilities ?? {});
    const supportsLoadSession = readLoadSessionCapability(input.capabilities);
    const mcpTemplates = JSON.stringify(stripMcpCredentials(input.mcpTemplates));
    const estimatedWarmUntil = estimateWarmUntil(input.harness, input.now);
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
                estimatedWarmUntil,
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
              estimatedWarmUntil,
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

  /** Record the ACP permission mode once it is set on the Session (afk Runs set
   * it after the handshake), touching `updatedAt`. The caller passes the id of
   * a Session it just recorded on the same dispatch, so the row always exists. */
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

  /** Record, on the ORIGINAL (dead) Session, why a `session/load` reload was
   * declined and a fresh summarized-Session was minted in its place (issue
   * #145 AC5). The caller passes a Session id it already resolved, so the row
   * always exists. */
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

  /** The Session for a harness's own session id, or undefined — the natural-key
   * lookup resume loads against. */
  async getByHarnessSession(harness: string, harnessSessionId: string): Promise<SessionRow | undefined> {
    return this.db.read((db) =>
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.harness, harness), eq(sessions.harnessSessionId, harnessSessionId)))
        .get(),
    );
  }

  // Session retirement is the sole owner of builder-worktree removal. These
  // methods move a Session through `active → idle → retiring → retired` and
  // record the worktree it owns; `SessionRetirementCoordinator` drives them and
  // performs the actual git removal. Transitions are guarded by
  // {@link canTransition} and are idempotent no-ops when already satisfied, so
  // the boot sweep is safe to run repeatedly.

  /** Bind the builder worktree this Session owns (issue #148): the base repo it
   * was carved from and its checkout path. Set when a **worktree-mode** Run's
   * workspace is prepared, so retirement knows what to remove. Argument order
   * matches `Git.removeWorktree`/`RemoveWorktree` (`repoDir`, then `worktreePath`)
   * so a value never gets swapped across the bind→remove round trip. Idempotent. */
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

  /** Move the Session to `idle` under a retention `deadline` (issue #148),
   * carrying the `reason` the sweep will retire it under. No-op (returns the row
   * unchanged) once the Session is already `retiring`/`retired` — a retirement
   * decision, once made, is never walked back to a retained state. */
  async markIdle(id: number, retireDeadline: number, reason: SessionRetireReason, now: number): Promise<SessionRow> {
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

  /** Move the Session to `retiring` (issue #148) — worktree removal is now owed;
   * a crash before `retired` leaves it here for the boot sweep to re-drive. Sets
   * the `reason` it is retiring under. No-op once already `retiring`/`retired`. */
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

  /** Move the Session to `retired` (issue #148) — its builder worktree has been
   * removed. Terminal; a no-op once already `retired`. */
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

  /** Reactivate an `idle` Session for a continuation Run reusing its retained
   * worktree (issue #148), clearing the retention deadline. No-op if not idle.
   * Substrate only: no production caller re-enters a retained workspace yet (the
   * reject-continuation Run is a later ticket); the retention half of "merges in
   * the same workspace" — the worktree surviving, bound to the Session — is what
   * #148 delivers, and this is the transition that half will resume through. */
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

  /** Every Session in `retiring` — worktree removal owed (issue #148). The drain
   * removes each one's worktree and marks it `retired`; a crash mid-removal
   * leaves it here for the next boot to re-drive. */
  async listRetiring(): Promise<SessionRow[]> {
    return this.db.read((db) => db.select().from(sessions).where(eq(sessions.status, 'retiring')).all());
  }

  /**
   * Every non-retired Session that still owns a builder worktree. The orphan
   * worktree reconcile uses this as its exclusion set: active and idle
   * Sessions are live, while a retiring Session remains owned by the retirement
   * coordinator until it records `retired` after removal.
   */
  async listWorktreeOwners(): Promise<SessionRow[]> {
    return this.db.read((db) => db.select().from(sessions).where(and(isNotNull(sessions.worktreePath), ne(sessions.status, 'retired'))).all());
  }

  /** Every `idle` Session whose retention deadline has lapsed as of `now` (issue
   * #148) — due to be swept into `retiring`. A null deadline never lapses. The
   * SQL prefilter narrows to idle rows with a deadline; {@link isRetentionElapsed}
   * is the single source of the lapse rule, so the query and predicate agree by
   * call, not by copy. */
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
