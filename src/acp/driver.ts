import type { ChildProcess } from 'node:child_process';
import { AcpConnection } from './connection.js';

export interface AcpDriverHandlers {
  /**
   * ACP session/update notifications — the harness's streamed output. The
   * second argument is the load-time replay flag (issue #144): `true` for a
   * historical update re-emitted while a `session/load` reload is in flight
   * ({@link AcpDriver.load}), `false` for current-turn output. Consumers
   * quarantine replay from every current-turn measurement — activity, usage,
   * `run_facts`, stall — via `domain/replay-quarantine.ts`; a handler that does
   * not care about history may simply omit the parameter (a one-arg callback is
   * assignable, so existing callers are unaffected).
   */
  onSessionUpdate: (update: { sessionUpdate: string; [key: string]: unknown }, replay: boolean) => void;
  /**
   * Agent→client request handler (session/request_permission, fs/*, …).
   * Returns the ACP result, or null to decline the capability. This is the
   * one seam where the Runner and the ConversationDriver differ — the
   * Runner auto-approves permissions, a Conversation asks the human.
   */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * The harness's ACP `initialize` result — its capability advertisement. The
 * fields Harmonic reads are optional and typed loosely because the set grows
 * with the ACP spec and differs per harness; unknown keys are preserved so the
 * whole object can be snapshotted (issue #141, reliability-design Unit C).
 * `agentCapabilities.loadSession` is the `session/load` support flag resume
 * eligibility keys on.
 */
export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: { loadSession?: boolean; additionalDirectories?: boolean; [key: string]: unknown };
  authMethods?: unknown[];
  [key: string]: unknown;
}

export interface AcpHandshake {
  cwd: string;
  mcpServers?: unknown[];
  /** ACP modelId to pin via session/set_model right after session/new; skipped when undefined. */
  modelId?: string | undefined;
  /**
   * Fired with the harness's `initialize` result — its advertised capabilities
   * — before `session/new`, so a caller can snapshot what the harness supports
   * (e.g. `session/load`) onto the durable Session (issue #141). Previously
   * this result was discarded.
   */
  onInitialize?: (result: AcpInitializeResult) => void;
  /**
   * Fired with the new sessionId immediately after session/new, before the
   * optional model pin — so a caller can persist the id even if the pin
   * then fails (the Runner stores it for usage backfill). Awaited, so a caller
   * whose persistence is async (ADR-0029) finishes before handshake returns —
   * preserving the ordering the sync store gave for free (the Runner reads the
   * Session row id it sets, right after the handshake).
   */
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

export interface PromptResult {
  stopReason?: string;
  usage?: Record<string, unknown>;
  _meta?: unknown;
}

/**
 * Everything {@link AcpDriver.load} needs to reload a stored Session (issue
 * #143, reliability-design Unit C) into a brand-new harness process via ACP
 * `session/load`. `sessionId` is the stored resume handle — the harness's own
 * session id from the original dispatch (`sessions.harnessSessionId`), never a
 * Harmonic-generated one. Deliberately mirrors {@link AcpHandshake}'s shape
 * (same `cwd`/`mcpServers`/`modelId`/`onInitialize` fields) so a caller can
 * follow the same pattern for both a fresh dispatch and a resume.
 */
export interface AcpLoadHandshake {
  /** The stored harness ACP session id to reload — the resume handle (sessions.harnessSessionId). */
  sessionId: string;
  cwd: string;
  /** Freshly-credentialed session/new-shape mcpServers (see graftMcpCredentials); creds are minted fresh, never persisted. */
  mcpServers?: unknown[];
  /** Extra roots the reload needs beyond cwd; sent ONLY when the harness advertises support, else the load is incompatible. */
  additionalDirectories?: readonly string[];
  /** ACP modelId to re-pin via session/set_model after load (model change is allowed but re-verified). */
  modelId?: string | undefined;
  /** The permission mode to re-establish after load; incompatible if the reloaded harness no longer advertises it. */
  permissionMode?: string | undefined;
  onInitialize?: (result: AcpInitializeResult) => void;
}

/**
 * Why {@link AcpDriver.load} declined to send `session/load` (or declined the
 * mode it did) — a resume incompatibility a caller acts on by minting a fresh
 * Session (via {@link AcpDriver.handshake}) rather than a defect to fix.
 * `assessResumeEligibility` (session-resume.ts, issue #142) reasons about the
 * SAME set of incompatibilities ahead of a reload attempt; this is what the
 * live harness process can additionally discover only by actually asking it.
 */
export type AcpLoadIncompatibility =
  | 'load-session-unsupported'
  | 'additional-directories-unsupported'
  | 'permission-mode-unestablishable';

/**
 * `load()`'s result — a discriminated union, not a thrown error, because an
 * incompatibility here is an EXPECTED outcome (the live harness turns out not
 * to support what the stored Session needs) that a caller routes around by
 * falling back to a fresh dispatch. Only genuine transport failure — the
 * child dying mid-request, same as {@link AcpDriver.handshake} — still throws
 * (via `race`).
 */
export type AcpLoadOutcome =
  | { loaded: true }
  | { loaded: false; reason: AcpLoadIncompatibility; detail: string };

/**
 * The shared ACP drive sequence over a spawned harness's stdio —
 * initialize → session/new → optional session/set_model, then one
 * session/prompt per turn. Extracted from the Runner (ADR-0006) so the
 * Runner and the ConversationDriver drive a harness identically; they
 * differ only in their handlers and in how long they keep the session
 * warm (the Runner disposes after one turn, a Conversation prompts many
 * times on one session).
 *
 * {@link load} is the resume counterpart of {@link handshake} (issue #143,
 * reliability-design Unit C): it reloads a stored Session's ACP session id
 * into a BRAND-NEW harness process via `session/load` — there is no
 * reattaching to a still-running process, every resume starts a fresh spawn
 * and re-runs `initialize` on it. Cache warmth (`estimateWarmUntil` in
 * sessions.ts) is a COST signal about that fresh process's prompt cache, never
 * a correctness gate on whether load is attempted — a cold reload (the common
 * case: the prior process is long gone) works identically to a warm one, just
 * more expensively. `load()` re-verifies, against the LIVE harness's own
 * `initialize` advertisement, every capability the stored Session assumed
 * (`loadSession`, `additionalDirectories`, the permission mode) rather than
 * trusting the snapshot taken at the original dispatch — a harness can be
 * upgraded/downgraded between dispatch and resume, and the snapshot is a
 * point-in-time capability discovery, not a promise.
 */
export class AcpDriver {
  private readonly connection: AcpConnection;
  /** Rejects when the child dies, so every in-flight request loses the race. */
  private readonly exited: Promise<never>;
  sessionId = '';
  /** Session mode ids the harness offers, from session/new — e.g. Claude's permission modes (auto, bypassPermissions, …). */
  availableModes: string[] = [];
  /**
   * True only while a `session/load` request is in flight (issue #144). ACP
   * streams a reloaded Session's entire historical `session/update` stream as
   * notifications BEFORE the `session/load` response returns, so any update
   * observed in this window is replay, not current-turn output. {@link load}
   * brackets the request with this flag; the connection handler tags each update
   * with it, so a consumer can quarantine replayed history (see
   * `domain/replay-quarantine.ts`).
   */
  private loading = false;

  constructor(child: ChildProcess, handlers: AcpDriverHandlers) {
    this.connection = new AcpConnection(child.stdin!, child.stdout!, {
      onSessionUpdate: (params) => handlers.onSessionUpdate(params.update, this.loading),
      onRequest: handlers.onRequest,
    });
    this.exited = new Promise<never>((_, reject) => {
      child.on('error', (err) => reject(new Error(`harness spawn failed: ${err.message}`)));
      child.on('exit', (code, signal) =>
        reject(new Error(`harness exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) before finishing`)),
      );
    });
  }

  /**
   * Send ACP `initialize` and hand the harness's capability advertisement to
   * `onInitialize` — the first step of both {@link handshake} and {@link load},
   * so the request params and the capture callback stay in one place.
   */
  private async initialize(onInitialize?: (result: AcpInitializeResult) => void): Promise<AcpInitializeResult> {
    const result = (await this.race(
      this.connection.request('initialize', { protocolVersion: 1, clientCapabilities: {} }),
    )) as AcpInitializeResult;
    onInitialize?.(result);
    return result;
  }

  /** The mode ids a `session/new`/`session/load` response advertises, in order. */
  private static modeIdsOf(modes?: { availableModes?: { id: string }[] }): string[] {
    return (modes?.availableModes ?? []).map((mode) => mode.id);
  }

  /** initialize → session/new → optional session/set_model. Sets sessionId. */
  async handshake(opts: AcpHandshake): Promise<string> {
    await this.initialize(opts.onInitialize);
    const session = (await this.race(
      this.connection.request('session/new', { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] }),
    )) as { sessionId: string; modes?: { availableModes?: { id: string }[] } };
    this.sessionId = session.sessionId;
    this.availableModes = AcpDriver.modeIdsOf(session.modes);
    await opts.onSessionCreated?.(this.sessionId);
    if (opts.modelId !== undefined) {
      await this.race(
        this.connection.request('session/set_model', { sessionId: this.sessionId, modelId: opts.modelId }),
      );
    }
    return this.sessionId;
  }

  /**
   * initialize → (capability check) → session/load → optional
   * session/set_mode → optional session/set_model. The resume counterpart of
   * {@link handshake} (issue #143): reloads `opts.sessionId` — a stored
   * Session's harness session id — into THIS driver's (already spawned,
   * fresh) harness process. Returns an {@link AcpLoadOutcome}; an
   * incompatibility is returned, not thrown — only child death/transport
   * failure throws, via `race`, exactly like `handshake`. On EVERY incompatible
   * outcome the driver adopts no session (`sessionId`/`availableModes` stay
   * unset), so the caller disposes the fresh process uniformly: the two
   * capability checks short-circuit before `session/load` is even sent, while
   * `permission-mode-unestablishable` is only discoverable from the reload
   * response (so `session/load` was sent) — but the loaded session is still
   * abandoned rather than adopted, since it's disposed with the process anyway.
   *
   * The `session/load` request is bracketed by {@link loading} so the historical
   * `session/update` stream the harness replays during it is tagged `replay` on
   * `onSessionUpdate` (issue #144) — replayed history is quarantined from all
   * current-turn measurement downstream.
   */
  async load(opts: AcpLoadHandshake): Promise<AcpLoadOutcome> {
    const initResult = await this.initialize(opts.onInitialize);

    // AC2: the LIVE harness — not the capability snapshot taken at the
    // original dispatch — must still advertise session/load.
    if (initResult.agentCapabilities?.loadSession !== true) {
      return {
        loaded: false,
        reason: 'load-session-unsupported',
        detail: 'harness did not advertise session/load at initialize',
      };
    }

    // AC3: additional roots are only meaningful — and only sent — when the
    // Session actually needs them; a harness that doesn't advertise the
    // capability is only an incompatibility when roots are actually requested.
    const needsRoots = (opts.additionalDirectories?.length ?? 0) > 0;
    if (needsRoots && initResult.agentCapabilities?.additionalDirectories !== true) {
      return {
        loaded: false,
        reason: 'additional-directories-unsupported',
        detail: 'session requires additional roots the harness does not support',
      };
    }

    // Bracket the request so every `session/update` the harness streams as it
    // replays the reloaded Session's history is tagged `replay` (issue #144).
    // ACP sends that whole historical stream before this response resolves, so
    // the flag is set for exactly the replay window and cleared in `finally`
    // even if the reload rejects (child death via `race`).
    this.loading = true;
    let loaded: { modes?: { availableModes?: { id: string }[] } };
    try {
      loaded = (await this.race(
        this.connection.request('session/load', {
          sessionId: opts.sessionId,
          cwd: opts.cwd,
          mcpServers: opts.mcpServers ?? [],
          ...(needsRoots ? { additionalDirectories: opts.additionalDirectories } : {}),
        }),
      )) as { modes?: { availableModes?: { id: string }[] } };
    } finally {
      this.loading = false;
    }

    // AC4: re-verify modes off the reload response — not what the original
    // dispatch saw — and confirm the permission mode is still establishable
    // BEFORE adopting the session, so an incompatible outcome leaves the driver
    // holding no session state (matching the pre-`session/load` reasons above).
    const availableModes = AcpDriver.modeIdsOf(loaded.modes);
    if (opts.permissionMode !== undefined && !availableModes.includes(opts.permissionMode)) {
      return {
        loaded: false,
        reason: 'permission-mode-unestablishable',
        detail: `permission mode ${opts.permissionMode} not advertised by the reloaded harness`,
      };
    }
    this.sessionId = opts.sessionId;
    this.availableModes = availableModes;

    if (opts.permissionMode !== undefined) {
      await this.race(
        this.connection.request('session/set_mode', { sessionId: this.sessionId, modeId: opts.permissionMode }),
      );
    }

    // AC4: model change is allowed on resume — it's a re-verify, not a block.
    if (opts.modelId !== undefined) {
      await this.race(
        this.connection.request('session/set_model', { sessionId: this.sessionId, modelId: opts.modelId }),
      );
    }

    return { loaded: true };
  }

  /** Put the session into a permission mode (ACP session/set_mode) — e.g. Claude's 'auto'. */
  async setMode(modeId: string): Promise<void> {
    await this.race(this.connection.request('session/set_mode', { sessionId: this.sessionId, modeId }));
  }

  /** One prompt turn on the current session; rejects if the harness dies first. */
  async prompt(prompt: unknown): Promise<PromptResult> {
    return this.race(this.connection.request('session/prompt', { sessionId: this.sessionId, prompt }));
  }

  /** Cancel the in-flight turn (ACP session/cancel is a notification, not a request). */
  cancel(): void {
    this.connection.notify('session/cancel', { sessionId: this.sessionId });
  }

  /**
   * Steer the in-flight turn via ACP `_session/steering` (claude-agent-acp
   * ≥0.69): inject `prompt` into the RUNNING turn at the harness's steer
   * priority — pre-empting the current generation without cancelling the turn.
   * Returns the harness's outcome. Rejects if the harness does not implement
   * the method (JSON-RPC "method not found") or the child dies first, so
   * callers can fall back to boundary queueing.
   */
  async steer(prompt: unknown, meta?: unknown): Promise<{ outcome: string; reason?: string }> {
    return this.race(
      this.connection.request('_session/steering', {
        sessionId: this.sessionId,
        prompt,
        ...(meta !== undefined ? { _meta: meta } : {}),
      }),
    );
  }

  /** Race any request against child death. */
  private race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.exited]);
  }

  fail(err: Error): void {
    this.connection.fail(err);
  }

  dispose(): void {
    this.connection.dispose();
  }
}
