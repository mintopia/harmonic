import type { ChildProcess } from 'node:child_process';
import { AcpConnection, AcpConnectionClosedError } from './connection.js';
import { startOperation } from '../telemetry/operations.js';

/**
 * A prompt turn was cancelled because the harness fell silent — no
 * `session/update` and no outstanding tool call — for longer than the
 * configured inactivity bound. The drive loop treats it as a turn end, not a
 * failure: the connection is still alive.
 */
export class AcpPromptTimeoutError extends Error {
  constructor(public readonly inactivityMs: number) {
    super(`ACP prompt turn cancelled after ${inactivityMs}ms of inactivity`);
    this.name = 'AcpPromptTimeoutError';
  }
}

export interface AcpDriverHandlers {
  /**
   * ACP session/update notifications — the harness's streamed output. The
   * second argument is the replay flag: `true` for a historical update
   * re-emitted while a `session/load` reload is in flight, `false` for
   * current-turn output.
   */
  onSessionUpdate: (update: { sessionUpdate: string; [key: string]: unknown }, replay: boolean) => void;
  /**
   * Agent→client request handler (session/request_permission, fs/*, …).
   * Returns the ACP result, or null to decline the capability.
   */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * The harness's ACP `initialize` result — its capability advertisement. Typed
 * loosely because the set grows with the ACP spec and differs per harness;
 * unknown keys are preserved so the whole object can be snapshotted.
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
   * Fired with the harness's `initialize` result before `session/new`, so a
   * caller can snapshot what the harness supports onto the durable Session.
   */
  onInitialize?: (result: AcpInitializeResult) => void;
  /**
   * Fired with the new sessionId immediately after session/new, before the
   * optional model pin, so a caller can persist the id even if the pin then
   * fails. Awaited, so async persistence finishes before handshake returns.
   */
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

export interface PromptResult {
  stopReason?: string;
  usage?: Record<string, unknown>;
  _meta?: unknown;
}

/**
 * Everything {@link AcpDriver.load} needs to reload a stored Session into a
 * brand-new harness process via ACP `session/load`. `sessionId` is the
 * harness's own session id from the original dispatch, never a
 * Harmonic-generated one.
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
 * Session rather than a defect to fix.
 */
export type AcpLoadIncompatibility =
  | 'load-session-unsupported'
  | 'additional-directories-unsupported'
  | 'permission-mode-unestablishable';

/**
 * `load()`'s result. An incompatibility is an expected outcome a caller routes
 * around by falling back to a fresh dispatch, so it is a union member, not a
 * thrown error. Only transport failure (the child dying mid-request) throws.
 */
export type AcpLoadOutcome =
  | { loaded: true }
  | { loaded: false; reason: AcpLoadIncompatibility; detail: string };

/**
 * The shared ACP drive sequence over a spawned harness's stdio —
 * initialize → session/new → optional session/set_model, then one
 * session/prompt per turn.
 *
 * {@link load} is the resume counterpart of {@link handshake}: it reloads a
 * stored Session's ACP session id into a brand-new harness process via
 * `session/load` — there is no reattaching to a still-running process.
 * `load()` re-verifies every capability the stored Session assumed against the
 * live harness's own `initialize` advertisement, since a harness can be
 * upgraded/downgraded between dispatch and resume.
 */
export class AcpDriver {
  private readonly connection: AcpConnection;
  private readonly exited: Promise<never>;
  sessionId = '';
  /** Session mode ids the harness offers, from session/new — e.g. Claude's permission modes (auto, bypassPermissions, …). */
  availableModes: string[] = [];
  /**
   * True while a `session/load` request is in flight: ACP streams the reloaded
   * Session's history as `session/update` notifications BEFORE the response
   * returns, so any update observed in this window is replay.
   */
  private loading = false;
  private lastActivityAt = 0;
  private readonly outstandingTools = new Set<string>();
  private completionGraceMs: number | null = null;

  constructor(
    child: ChildProcess,
    handlers: AcpDriverHandlers,
    /** Inactivity bound for a single prompt turn, ms; undefined/0 disables it. */
    private readonly promptInactivityTimeoutMs?: number,
  ) {
    this.connection = new AcpConnection(child.stdin!, child.stdout!, {
      onSessionUpdate: (params) => {
        this.observeActivity(params.update);
        handlers.onSessionUpdate(params.update, this.loading);
      },
      onRequest: handlers.onRequest,
    });
    this.exited = new Promise<never>((_, reject) => {
      child.on('error', (err) => reject(new Error(`harness spawn failed: ${err.message}`)));
      child.on('exit', (code, signal) =>
        reject(new Error(`harness exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) before finishing`)),
      );
    });
  }

  private async initialize(onInitialize?: (result: AcpInitializeResult) => void): Promise<AcpInitializeResult> {
    const result = (await this.race(
      this.connection.request('initialize', { protocolVersion: 1, clientCapabilities: {} }),
    )) as AcpInitializeResult;
    onInitialize?.(result);
    return result;
  }

  private static modeIdsOf(modes?: { availableModes?: { id: string }[] }): string[] {
    return (modes?.availableModes ?? []).map((mode) => mode.id);
  }

  /** initialize → session/new → optional session/set_model. Sets sessionId. */
  async handshake(opts: AcpHandshake): Promise<string> {
    const operation = startOperation({ type: 'session.create', attributes: {} });
    try {
      const sessionId = await operation.run(async () => {
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
      });
      operation.update({ 'session.id': sessionId });
      operation.end();
      return sessionId;
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * initialize → (capability check) → session/load → optional
   * session/set_mode → optional session/set_model. The resume counterpart of
   * {@link handshake}: reloads `opts.sessionId` into this driver's fresh
   * harness process. Returns an {@link AcpLoadOutcome}; an incompatibility is
   * returned, not thrown — only child death/transport failure throws. On every
   * incompatible outcome the driver adopts no session (`sessionId`/
   * `availableModes` stay unset), so the caller disposes the fresh process
   * uniformly.
   */
  async load(opts: AcpLoadHandshake): Promise<AcpLoadOutcome> {
    const operation = startOperation({ type: 'session.load', attributes: { 'session.id': opts.sessionId } });
    try {
      const outcome = await operation.run(() => this.loadSession(opts));
      operation.update({ 'session.loaded': outcome.loaded, ...(outcome.loaded ? {} : { 'session.load.reason': outcome.reason }) });
      operation.end();
      return outcome;
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async loadSession(opts: AcpLoadHandshake): Promise<AcpLoadOutcome> {
    const initResult = await this.initialize(opts.onInitialize);

    if (initResult.agentCapabilities?.loadSession !== true) {
      return {
        loaded: false,
        reason: 'load-session-unsupported',
        detail: 'harness did not advertise session/load at initialize',
      };
    }

    const needsRoots = (opts.additionalDirectories?.length ?? 0) > 0;
    if (needsRoots && initResult.agentCapabilities?.additionalDirectories !== true) {
      return {
        loaded: false,
        reason: 'additional-directories-unsupported',
        detail: 'session requires additional roots the harness does not support',
      };
    }

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

  private observeActivity(update: { sessionUpdate: string; [key: string]: unknown }): void {
    this.lastActivityAt = Date.now();
    const u = update as { sessionUpdate?: string; toolCallId?: unknown; status?: unknown };
    const id = typeof u.toolCallId === 'string' ? u.toolCallId : null;
    if (!id) return;
    if (u.sessionUpdate === 'tool_call') this.outstandingTools.add(id);
    else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed'))
      this.outstandingTools.delete(id);
  }

  /**
   * One prompt turn on the current session; rejects if the harness dies first.
   * When an inactivity bound is configured it also rejects with
   * {@link AcpPromptTimeoutError} — after cancelling the in-flight turn — if the
   * harness falls silent (no `session/update`, no outstanding tool call) for
   * longer than the bound, so a lost `session/prompt` response ends the turn
   * instead of blocking forever.
   */
  async prompt(prompt: unknown): Promise<PromptResult> {
    const request = this.connection.request('session/prompt', { sessionId: this.sessionId, prompt });
    if (!this.promptInactivityTimeoutMs) return this.race(request);
    return this.race(this.withInactivityTimeout(request, this.promptInactivityTimeoutMs));
  }

  private withInactivityTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
    this.lastActivityAt = Date.now();
    this.outstandingTools.clear();
    this.completionGraceMs = null;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        fn();
      };
      const period = Math.max(1_000, Math.min(timeoutMs, 5_000));
      const timer = setInterval(() => {
        const grace = this.completionGraceMs;
        if (grace == null && this.outstandingTools.size > 0) return;
        const idleMs = Date.now() - this.lastActivityAt;
        if (idleMs < (grace ?? timeoutMs)) return;
        finish(() => {
          this.cancel();
          reject(new AcpPromptTimeoutError(idleMs));
        });
      }, period);
      timer.unref?.();
      request.then(
        (value) => finish(() => resolve(value)),
        (err) => finish(() => reject(err)),
      );
    });
  }

  /** Cancel the in-flight turn (ACP session/cancel is a notification, not a request). */
  cancel(): void {
    this.connection.notify('session/cancel', { sessionId: this.sessionId });
  }

  /**
   * The agent has signalled completion (`finish_task`/`escalate_task`): bound
   * the in-flight turn to `graceMs` of silence, ignoring outstanding tools.
   * Cleared at the next turn start. No-op when no inactivity bound is configured.
   */
  expectCompletion(graceMs: number): void {
    if (!this.promptInactivityTimeoutMs) return;
    this.completionGraceMs = graceMs;
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

  /**
   * Race a request against child death. Killing the harness closes stdout too,
   * so the connection's readline `close` can reject with
   * {@link AcpConnectionClosedError} moments before the child `exit` fires;
   * prefer the child-death error. A close with the child still alive is the
   * genuine EOF and surfaces as {@link AcpConnectionClosedError}.
   */
  private async race<T>(p: Promise<T>): Promise<T> {
    try {
      return await Promise.race([p, this.exited]);
    } catch (err) {
      if (err instanceof AcpConnectionClosedError) {
        const exitErr = await this.raceChildExit(100);
        if (exitErr) throw exitErr;
      }
      throw err;
    }
  }

  private raceChildExit(ms: number): Promise<Error | null> {
    return Promise.race([
      this.exited.then(
        () => null,
        (err: Error) => err,
      ),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  }

  fail(err: Error): void {
    this.connection.fail(err);
  }

  dispose(): void {
    this.connection.dispose();
  }
}
