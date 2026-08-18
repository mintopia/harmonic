import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, type SessionRow } from '../db/schema.js';
import type { AcpInitializeResult } from '../acp/driver.js';
import { DomainError } from './errors.js';

/**
 * Keys on an MCP server template that can carry a secret. `session/new`
 * mcpServers today are HTTP servers with an `Authorization: Bearer <RunKey>`
 * header, but stdio servers (other harnesses) can carry secrets in `env`, and
 * a token could appear inline — so the credential-free template drops every one
 * of these defensively. Credentials are minted fresh at load/dispatch and
 * grafted back on; they are never persisted (issue #141 acceptance criterion).
 */
const CREDENTIAL_KEYS = new Set(['headers', 'env', 'token', 'authorization', 'apikey', 'api_key', 'bearer']);

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
 * C builds on, so the store only records and reads — retirement/load land later.
 */
export class SessionStore {
  constructor(private readonly db: Db) {}

  /**
   * Persist the Session for a dispatch, upserting on `(harness,
   * harnessSessionId)`. A fresh dispatch inserts; a reused harness session
   * (when resume lands) refreshes the capability snapshot, model/cwd, templates
   * and `lastActiveAt` and re-marks it `active`. Credentials are stripped from
   * `mcpTemplates` and never stored; `capabilitySnapshot` holds the whole
   * `initialize` result and `supportsLoadSession` is mined from it.
   */
  recordDispatch(input: DispatchSessionInput): SessionRow {
    const capabilitySnapshot = JSON.stringify(input.capabilities ?? {});
    const supportsLoadSession = readLoadSessionCapability(input.capabilities);
    const mcpTemplates = JSON.stringify(stripMcpCredentials(input.mcpTemplates));
    const estimatedWarmUntil = estimateWarmUntil(input.harness, input.now);
    const existing = this.getByHarnessSession(input.harness, input.harnessSessionId);
    if (existing) {
      return this.db
        .update(sessions)
        .set({
          model: input.model,
          cwd: input.cwd,
          workspaceId: input.workspaceId,
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
        .get()!;
    }
    return this.db
      .insert(sessions)
      .values({
        harness: input.harness,
        harnessSessionId: input.harnessSessionId,
        model: input.model,
        cwd: input.cwd,
        workspaceId: input.workspaceId,
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
  }

  /** Record the ACP permission mode once it is set on the Session (afk Runs set
   * it after the handshake), touching `updatedAt`. No-op-safe: returns the
   * unchanged row if the Session is gone. */
  setPermissionMode(id: number, permissionMode: string, now: number): SessionRow {
    return this.db
      .update(sessions)
      .set({ permissionMode, updatedAt: now })
      .where(eq(sessions.id, id))
      .returning()
      .get()!;
  }

  get(id: number): SessionRow {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) throw new DomainError('not_found', `session ${id} not found`);
    return row;
  }

  /** The Session for a harness's own session id, or undefined — the natural-key
   * lookup resume loads against. */
  getByHarnessSession(harness: string, harnessSessionId: string): SessionRow | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.harness, harness), eq(sessions.harnessSessionId, harnessSessionId)))
      .get();
  }
}
