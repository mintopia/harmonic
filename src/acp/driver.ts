import type { ChildProcess } from 'node:child_process';
import { AcpConnection } from './connection.js';

export interface AcpDriverHandlers {
  /** ACP session/update notifications — the harness's streamed output. */
  onSessionUpdate: (update: { sessionUpdate: string; [key: string]: unknown }) => void;
  /**
   * Agent→client request handler (session/request_permission, fs/*, …).
   * Returns the ACP result, or null to decline the capability. This is the
   * one seam where the Runner and the ConversationDriver differ — the
   * Runner auto-approves permissions, a Conversation asks the human.
   */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
}

export interface AcpHandshake {
  cwd: string;
  mcpServers?: unknown[];
  /** ACP modelId to pin via session/set_model right after session/new; skipped when undefined. */
  modelId?: string | undefined;
  /**
   * Fired with the new sessionId immediately after session/new, before the
   * optional model pin — so a caller can persist the id even if the pin
   * then fails (the Runner stores it for usage backfill).
   */
  onSessionCreated?: (sessionId: string) => void;
}

export interface PromptResult {
  stopReason?: string;
  usage?: Record<string, unknown>;
  _meta?: unknown;
}

/**
 * The shared ACP drive sequence over a spawned harness's stdio —
 * initialize → session/new → optional session/set_model, then one
 * session/prompt per turn. Extracted from the Runner (ADR-0006) so the
 * Runner and the ConversationDriver drive a harness identically; they
 * differ only in their handlers and in how long they keep the session
 * warm (the Runner disposes after one turn, a Conversation prompts many
 * times on one session).
 */
export class AcpDriver {
  private readonly connection: AcpConnection;
  /** Rejects when the child dies, so every in-flight request loses the race. */
  private readonly exited: Promise<never>;
  sessionId = '';
  /** Session mode ids the harness offers, from session/new — e.g. Claude's permission modes (auto, bypassPermissions, …). */
  availableModes: string[] = [];

  constructor(child: ChildProcess, handlers: AcpDriverHandlers) {
    this.connection = new AcpConnection(child.stdin!, child.stdout!, {
      onSessionUpdate: (params) => handlers.onSessionUpdate(params.update),
      onRequest: handlers.onRequest,
    });
    this.exited = new Promise<never>((_, reject) => {
      child.on('error', (err) => reject(new Error(`harness spawn failed: ${err.message}`)));
      child.on('exit', (code, signal) =>
        reject(new Error(`harness exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) before finishing`)),
      );
    });
  }

  /** initialize → session/new → optional session/set_model. Sets sessionId. */
  async handshake(opts: AcpHandshake): Promise<string> {
    await this.race(this.connection.request('initialize', { protocolVersion: 1, clientCapabilities: {} }));
    const session = (await this.race(
      this.connection.request('session/new', { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] }),
    )) as { sessionId: string; modes?: { availableModes?: { id: string }[] } };
    this.sessionId = session.sessionId;
    this.availableModes = (session.modes?.availableModes ?? []).map((mode) => mode.id);
    opts.onSessionCreated?.(this.sessionId);
    if (opts.modelId !== undefined) {
      await this.race(
        this.connection.request('session/set_model', { sessionId: this.sessionId, modelId: opts.modelId }),
      );
    }
    return this.sessionId;
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
