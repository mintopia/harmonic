import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AcpDriver } from '../acp/driver.js';
import { adapterFor } from './harness/adapter.js';
import { DomainError } from '../domain/errors.js';
import type { AppConfig } from '../config.js';
import type { ConversationStore, PersistedConversationEvent } from '../domain/conversations.js';
import type { ConversationRow } from '../db/schema.js';

export interface ConversationDriverEvents {
  /** Fired after every conversation event is persisted (live streaming hook). */
  onEvent?: (event: PersistedConversationEvent) => void;
}

export interface ConversationDriverOptions {
  events?: ConversationDriverEvents;
}

interface ActiveConversation {
  conversationId: number;
  child: ChildProcess;
  driver: AcpDriver;
  /** A Turn is being prompted right now — one at a time per Conversation (issue 14 queues). */
  turning: boolean;
}

/**
 * Drives Conversations (ADR-0006): lazily spawns a Harness on the first
 * Turn, keeps it warm across many Turns on one ACP session (surviving
 * panel/socket close), and tears it down on an explicit End or a harness
 * death. The inverse of the Runner in lifetime — a Runner disposes after
 * one prompt; a Conversation prompts many times on one session.
 *
 * Direct mode only — no Isolation Mode (ADR-0006). Permissions are
 * auto-approved in this slice; issue 11 makes them human-in-the-loop.
 */
export class ConversationDriver {
  private readonly active = new Map<number, ActiveConversation>();
  private readonly events: ConversationDriverEvents;

  constructor(
    private readonly store: ConversationStore,
    private readonly getConfig: () => AppConfig,
    options: ConversationDriverOptions = {},
  ) {
    this.events = options.events ?? {};
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** True while a warm harness process is held for this Conversation. */
  isWarm(conversationId: number): boolean {
    return this.active.has(conversationId);
  }

  /**
   * Send one operator Turn. Spawns the harness on the first Turn (awaited,
   * so spawn/handshake errors reach the caller); the reply then streams
   * over the firehose while this returns. A second Turn reuses the warm
   * session.
   */
  async submitTurn(conversationId: number, text: string): Promise<void> {
    const convo = this.store.get(conversationId);
    if (convo.state !== 'active') {
      throw new DomainError('invalid_state', `conversation ${conversationId} has ended`);
    }
    let entry = this.active.get(conversationId);
    if (entry?.turning) {
      // Issue 14 replaces this with queue-or-interrupt steering.
      throw new DomainError('invalid_state', 'a turn is already in progress');
    }
    if (!entry) entry = await this.spawn(convo);

    entry.turning = true;
    this.record(conversationId, 'user_turn', { text });
    // Stream the reply asynchronously — the operator watches it over the WS,
    // the HTTP call returns as soon as the Turn is under way.
    void this.runTurn(entry, text);
  }

  /** Explicit End: stop the harness and mark the Conversation ended. */
  end(conversationId: number): ConversationRow {
    const entry = this.active.get(conversationId);
    if (entry) this.teardown(entry);
    return this.store.end(conversationId);
  }

  /** Process shutdown: kill every warm harness (the DB rows stay for issue 15's restart sweep). */
  shutdown(): void {
    for (const entry of this.active.values()) this.kill(entry);
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
    const child = spawn(harness.command, harness.args, {
      cwd: convo.workingDir,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const driver = new AcpDriver(child, {
      onSessionUpdate: (update) => this.record(convo.id, 'session_update', update),
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') {
          // TEMPORARY (issue 11): auto-approve so the skeleton streams
          // without blocking. Interactive human-in-the-loop permissions
          // replace this — the driver will hold the request open instead.
          const options = (params as any)?.options ?? [];
          const pick =
            options.find((o: any) => o.kind === 'allow_always') ??
            options.find((o: any) => o.kind === 'allow_once') ??
            options[0];
          const outcome = pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
          this.record(convo.id, 'permission_request', { request: params, outcome });
          return { outcome };
        }
        return null;
      },
    });

    const entry: ActiveConversation = { conversationId: convo.id, child, driver, turning: false };
    this.active.set(convo.id, entry);
    try {
      const modelId = adapterFor(convo.harness).sessionModelId?.(convo.model);
      await driver.handshake({
        cwd: convo.workingDir,
        modelId,
        onSessionCreated: (sessionId) => this.store.update(convo.id, { sessionId }),
      });
    } catch (err) {
      // Spawn/handshake failed: the Conversation never became warm. Clean
      // up but leave it active — the operator can try again.
      this.active.delete(convo.id);
      this.kill(entry);
      driver.fail(err instanceof Error ? err : new Error(String(err)));
      driver.dispose();
      throw err;
    }
    return entry;
  }

  private async runTurn(entry: ActiveConversation, text: string): Promise<void> {
    try {
      const result = await entry.driver.prompt([{ type: 'text', text }]);
      this.record(entry.conversationId, 'lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
      this.store.touch(entry.conversationId);
    } catch (err) {
      // The harness died mid-Turn: the warm session is gone, so the
      // Conversation ends honestly (it cannot resume) rather than silently
      // re-spawning a fresh, context-less session.
      const message = err instanceof Error ? err.message : String(err);
      this.record(entry.conversationId, 'lifecycle', { event: 'error', message });
      this.teardown(entry);
      this.store.end(entry.conversationId);
    } finally {
      entry.turning = false;
    }
  }

  private record(
    conversationId: number,
    type: 'session_update' | 'permission_request' | 'lifecycle' | 'user_turn',
    payload: unknown,
  ): void {
    const event = this.store.appendEvent(conversationId, { type, payload });
    this.events.onEvent?.(event);
  }

  private teardown(entry: ActiveConversation): void {
    this.active.delete(entry.conversationId);
    this.kill(entry);
    entry.driver.fail(new Error('conversation ended'));
    entry.driver.dispose();
  }

  private kill(entry: ActiveConversation): void {
    try {
      if (entry.child.exitCode === null && !entry.child.killed) entry.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
