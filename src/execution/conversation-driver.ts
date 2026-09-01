import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AcpDriver } from '../acp/driver.js';
import { adapterFor } from './harness/adapter.js';
import { accumulateUsage, collectUsageWithRetry, type AttemptUsage } from './usage.js';
import { resolvePrices } from '../domain/pricing.js';
import { DomainError } from '../domain/errors.js';
import type { AppConfig } from '../config.js';
import type { ConversationStore, PersistedConversationEvent } from '../domain/conversations.js';
import type { PermissionRuleStore } from '../domain/permission-rules.js';
import type { ConversationRow } from '../db/schema.js';
import { startOperation } from '../telemetry/operations.js';

function permissionKind(request: unknown): string | null {
  const kind = (request as any)?.toolCall?.kind;
  return typeof kind === 'string' && kind ? kind : null;
}

function allowOptionId(request: unknown): string | null {
  const options = (request as any)?.options ?? [];
  const pick =
    options.find((o: any) => o.kind === 'allow_once') ??
    options.find((o: any) => o.kind === 'allow_always') ??
    options[0];
  return pick?.optionId ?? null;
}

export interface PendingPermissionBroadcast {
  conversationId: number;
  reqId: string;
  /** The ACP session/request_permission params (toolCall + options). */
  request: unknown;
}

export interface ConversationDriverEvents {
  /** Fired after every conversation event is persisted (live streaming hook). */
  onEvent?: (event: PersistedConversationEvent) => void;
  /**
   * A Harness is asking permission and the Turn is now blocked on the
   * operator. Broadcast so the panel can prompt; the request is answered
   * out-of-band via `answerPermission`.
   */
  onPermissionRequest?: (pending: PendingPermissionBroadcast) => void;
}

type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

interface PendingPermission {
  conversationId: number;
  workingDir: string;
  request: unknown;
  resolve: (outcome: PermissionOutcome) => void;
}

export interface ConversationDriverOptions {
  events?: ConversationDriverEvents;
  /** Persistent Permission Rules; when set, a matching rule auto-approves without prompting. */
  rules?: PermissionRuleStore;
  /** Mints/revokes the per-Conversation scoped MCP key injected into the harness. */
  keys?: {
    mint: (conversationId: number) => Promise<string>;
    revoke: (conversationId: number) => void | Promise<void>;
  };
}

interface ActiveConversation {
  conversationId: number;
  child: ChildProcess;
  driver: AcpDriver;
  turning: boolean;
  queue: string[];
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Drives Conversations: lazily spawns a Harness on the first Turn, keeps it
 * warm across many Turns on one ACP session (surviving panel/socket close),
 * and tears it down on an explicit End or a harness death. Direct mode only.
 * Permissions are human-in-the-loop: the driver holds each
 * session/request_permission open and prompts the operator.
 */
export class ConversationDriver {
  private readonly active = new Map<number, ActiveConversation>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private nextPermissionId = 0;
  private readonly events: ConversationDriverEvents;
  private readonly rules: PermissionRuleStore | undefined;
  private readonly keys: ConversationDriverOptions['keys'];
  /** The MCP endpoint agents call back to; set once the server listens. */
  mcpUrl: string | null = null;

  constructor(
    private readonly store: ConversationStore,
    private readonly getConfig: () => AppConfig,
    options: ConversationDriverOptions = {},
  ) {
    this.events = options.events ?? {};
    this.rules = options.rules;
    this.keys = options.keys;
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** The ids of every warm (active) Conversation. */
  activeConversationIds(): number[] {
    return [...this.active.keys()];
  }

  /** True while a warm harness process is held for this Conversation. */
  isWarm(conversationId: number): boolean {
    return this.active.has(conversationId);
  }

  /**
   * Send one operator Turn. Spawns the harness on the first Turn (awaited,
   * so spawn/handshake errors reach the caller); the reply then streams
   * over the firehose while this returns. A second Turn reuses the warm
   * session. If a Turn is already in flight, the message is queued and sent
   * as the next Turn on completion — `queued` reports which.
   */
  async submitTurn(conversationId: number, text: string): Promise<{ queued: boolean }> {
    const convo = await this.store.get(conversationId);
    if (convo.state !== 'active') {
      throw new DomainError('invalid_state', `conversation ${conversationId} has ended`);
    }
    let entry = this.active.get(conversationId);
    if (entry?.turning) {
      entry.queue.push(text);
      return { queued: true };
    }
    if (!entry) entry = await this.spawn(convo);
    await this.beginTurn(entry, text);
    return { queued: false };
  }

  /**
   * Steer a running Turn: cancel the in-flight Turn via ACP session/cancel
   * and re-prompt with `text` as the next Turn — or just stop it, when `text`
   * is empty. The cancelled Turn records a `cancelled` stop reason and the
   * steering message opens a new Turn.
   */
  async interrupt(conversationId: number, text?: string): Promise<void> {
    const convo = await this.store.get(conversationId);
    if (convo.state !== 'active') {
      throw new DomainError('invalid_state', `conversation ${conversationId} has ended`);
    }
    const steer = text && text.trim().length > 0 ? text : undefined;
    const entry = this.active.get(conversationId);
    if (entry?.turning) {
      entry.queue = steer ? [steer] : [];
      entry.driver.cancel();
      return;
    }
    if (steer !== undefined) await this.submitTurn(conversationId, steer);
  }

  private async beginTurn(entry: ActiveConversation, text: string): Promise<void> {
    this.clearIdle(entry);
    entry.turning = true;
    await this.record(entry.conversationId, 'user_turn', { text });
    void this.runTurn(entry, text);
  }

  private async drainQueue(entry: ActiveConversation): Promise<void> {
    if (!this.active.has(entry.conversationId)) return;
    const next = entry.queue.shift();
    if (next !== undefined) await this.beginTurn(entry, next);
  }

  private armIdle(entry: ActiveConversation): void {
    this.clearIdle(entry);
    const minutes = this.getConfig().conversationIdleTimeoutMinutes;
    if (!minutes || minutes <= 0) return;
    entry.idleTimer = setTimeout(() => {
      void (async () => {
        if (!this.active.has(entry.conversationId)) return;
        await this.record(entry.conversationId, 'lifecycle', { event: 'idle_timeout' });
        await this.end(entry.conversationId);
      })().catch(() => {});
    }, minutes * 60_000);
    entry.idleTimer.unref?.();
  }

  private clearIdle(entry: ActiveConversation): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  /**
   * Answer a held permission request. `optionId` is the ACP option the
   * operator chose — its kind (allow_once / allow_always / reject_*) is the
   * Harness's to interpret; "Allow for this conversation" is just the native
   * allow_always option, remembered for the session.
   */
  async answerPermission(conversationId: number, reqId: string, optionId: string, remember = false): Promise<void> {
    const pending = this.pendingPermissions.get(reqId);
    if (!pending || pending.conversationId !== conversationId) {
      throw new DomainError('not_found', `no pending permission '${reqId}' for conversation ${conversationId}`);
    }
    this.pendingPermissions.delete(reqId);
    let rule: { kind: string; workingDir: string } | undefined;
    if (remember && this.rules) {
      const kind = permissionKind(pending.request);
      if (kind) {
        const created = await this.rules.create({ kind, workingDir: pending.workingDir });
        rule = { kind: created.kind, workingDir: created.workingDir };
      }
    }
    const outcome = { outcome: 'selected' as const, optionId };
    pending.resolve(outcome);
    await this.record(conversationId, 'permission_request', { request: pending.request, outcome, reqId, ...(rule ? { rule } : {}) });
  }

  /** Explicit End: stop the harness and mark the Conversation ended. */
  async end(conversationId: number): Promise<ConversationRow> {
    const entry = this.active.get(conversationId);
    if (entry) this.teardown(entry);
    return this.store.end(conversationId);
  }

  /** Process shutdown: kill every warm harness (the DB rows stay for the restart sweep). */
  shutdown(): void {
    for (const entry of this.active.values()) {
      this.clearIdle(entry);
      this.kill(entry);
    }
    this.active.clear();
  }

  private async spawn(convo: ConversationRow): Promise<ActiveConversation> {
    if (!existsSync(convo.workingDir)) {
      throw new DomainError('validation', `working directory '${convo.workingDir}' does not exist`);
    }
    const config = this.getConfig();
    const harness = config.harnesses[convo.harness as keyof typeof config.harnesses];
    if (!harness) throw new DomainError('validation', `harness '${convo.harness}' is not configured`);

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...harness.env,
      HARMONIC_MODEL: convo.model,
      ...adapterFor(convo.harness).spawnEnv({
        model: convo.model,
        cwd: convo.workingDir,
        sessionLogDir: harness.sessionLogDir,
      }),
    };
    let mcpServers: unknown[] = [];
    if (this.keys && this.mcpUrl) {
      const token = await this.keys.mint(convo.id);
      env.HARMONIC_API_KEY = token;
      env.HARMONIC_MCP_URL = this.mcpUrl;
      mcpServers = adapterFor(convo.harness).mcpServers({ url: this.mcpUrl, token });
    }
    const child = spawn(harness.command, harness.args, {
      cwd: convo.workingDir,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const driver = new AcpDriver(child, {
      onSessionUpdate: (update) => {
        void this.record(convo.id, 'session_update', update).catch(() => {});
      },
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') return this.decidePermission(convo.id, convo.workingDir, params);
        return null;
      },
    });

    const entry: ActiveConversation = { conversationId: convo.id, child, driver, turning: false, queue: [] };
    this.active.set(convo.id, entry);
    try {
      const modelId = adapterFor(convo.harness).sessionModelId?.(convo.model);
      await driver.handshake({
        cwd: convo.workingDir,
        mcpServers,
        modelId,
        onSessionCreated: async (sessionId) => {
          await this.store.update(convo.id, { sessionId });
        },
      });
    } catch (err) {
      this.active.delete(convo.id);
      this.kill(entry);
      this.revokeKey(convo.id);
      driver.fail(err instanceof Error ? err : new Error(String(err)));
      driver.dispose();
      throw err;
    }
    return entry;
  }

  private async runTurn(entry: ActiveConversation, text: string): Promise<void> {
    try {
      const operation = startOperation({ type: 'conversation.turn', attributes: { 'conversation.id': entry.conversationId } });
      await operation.run(async () => {
        try {
          const result = await entry.driver.prompt([{ type: 'text', text }]);
          await this.record(entry.conversationId, 'lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
          await this.accumulateTurnUsage(entry.conversationId, result);
          operation.update({ ...(result.stopReason === undefined ? {} : { 'conversation.turn.stop-reason': result.stopReason }) });
          operation.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          operation.fail(message);
          await this.record(entry.conversationId, 'lifecycle', { event: 'error', message });
          this.teardown(entry);
          await this.store.end(entry.conversationId);
        }
      });
    } finally {
      entry.turning = false;
      await this.drainQueue(entry);
      if (this.active.has(entry.conversationId) && !entry.turning) this.armIdle(entry);
    }
  }

  private async decidePermission(conversationId: number, workingDir: string, request: unknown): Promise<PermissionOutcome> {
    const kind = permissionKind(request);
    const rule = kind ? ((await this.rules?.findMatch(kind, workingDir)) ?? null) : null;
    if (rule) {
      const optionId = allowOptionId(request);
      const outcome: PermissionOutcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
      await this.record(conversationId, 'permission_request', {
        request,
        outcome,
        rule: { kind: rule.kind, workingDir: rule.workingDir },
      });
      return outcome;
    }
    const reqId = `perm-${++this.nextPermissionId}`;
    return new Promise<PermissionOutcome>((resolve) => {
      this.pendingPermissions.set(reqId, { conversationId, workingDir, request, resolve });
      this.events.onPermissionRequest?.({ conversationId, reqId, request });
    });
  }

  private cancelPendingPermissions(conversationId: number): void {
    for (const [reqId, pending] of this.pendingPermissions) {
      if (pending.conversationId !== conversationId) continue;
      this.pendingPermissions.delete(reqId);
      const outcome = { outcome: 'cancelled' as const };
      pending.resolve(outcome);
      void this.record(conversationId, 'permission_request', { request: pending.request, outcome, reqId }).catch(() => {});
    }
  }

  private async accumulateTurnUsage(
    conversationId: number,
    result: { stopReason?: string; usage?: Record<string, unknown>; _meta?: unknown },
  ): Promise<void> {
    let turnUsage: AttemptUsage | null = null;
    try {
      const convo = await this.store.get(conversationId);
      const harness = this.getConfig().harnesses[convo.harness as keyof AppConfig['harnesses']];
      if (harness) {
        turnUsage = await collectUsageWithRetry({
          harnessId: convo.harness,
          harness,
          cwd: convo.workingDir,
          sessionId: convo.sessionId,
          promptResult: result,
          prices: resolvePrices(this.getConfig().prices),
          events: (await this.store.listEvents(conversationId)) as unknown as Parameters<typeof collectUsageWithRetry>[0]['events'],
        });
      }
    } catch {
    }
    const convo = await this.store.get(conversationId);
    const stored = convo.usage ? (JSON.parse(convo.usage) as AttemptUsage) : null;
    const accumulated = accumulateUsage(stored, turnUsage);
    const contextTokens = turnUsage?.contextTokens ?? null;
    await this.store.update(conversationId, {
      ...(accumulated ? { usage: JSON.stringify(accumulated) } : {}),
      ...(contextTokens !== null ? { contextTokens } : {}),
    });
  }

  private async record(
    conversationId: number,
    type: 'session_update' | 'permission_request' | 'lifecycle' | 'user_turn',
    payload: unknown,
  ): Promise<void> {
    const event = await this.store.appendEvent(conversationId, { type, payload });
    this.events.onEvent?.(event);
  }

  private teardown(entry: ActiveConversation): void {
    this.clearIdle(entry);
    this.cancelPendingPermissions(entry.conversationId);
    this.active.delete(entry.conversationId);
    this.kill(entry);
    this.revokeKey(entry.conversationId);
    entry.driver.fail(new Error('conversation ended'));
    entry.driver.dispose();
  }

  private revokeKey(conversationId: number): void {
    try {
      void Promise.resolve(this.keys?.revoke(conversationId)).catch(() => {});
    } catch {
    }
  }

  private kill(entry: ActiveConversation): void {
    try {
      if (entry.child.exitCode === null && !entry.child.killed) entry.child.kill('SIGKILL');
    } catch {}
  }
}
