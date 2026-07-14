import { spawn, type ChildProcess } from 'node:child_process';
import type { AppConfig } from '../config.js';
import type { TaskRow, RunRow } from '../db/schema.js';
import { AcpConnection } from '../acp/connection.js';
import { DomainError } from '../domain/errors.js';
import type { RunStore, PersistedRunEvent } from '../domain/runs.js';
import type { TaskService } from '../domain/tasks.js';

export interface RunnerEvents {
  /** Fired after every run event is persisted (live streaming hook). */
  onRunEvent?: (event: PersistedRunEvent) => void;
  /** Fired whenever a run reaches a terminal state. */
  onRunFinished?: (run: RunRow) => void;
}

interface ActiveRun {
  runId: number;
  taskId: number;
  child: ChildProcess;
  connection: AcpConnection;
}

/**
 * Spawns a task's harness, drives it over ACP, persists every
 * session/update as a run event, and settles the task's state from the
 * outcome. One prompt turn per run.
 */
export class Runner {
  private active = new Map<number, ActiveRun>(); // by run id

  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly getConfig: () => AppConfig,
    private readonly events: RunnerEvents = {},
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  /** Start a run for a ready task. Returns the created run immediately. */
  start(taskId: number): RunRow {
    const task = this.taskService.get(taskId);
    if (task.state !== 'ready') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only ready tasks can run`);
    }
    const config = this.getConfig();
    const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
    if (!harness) throw new DomainError('validation', `harness '${task.harness}' is not configured`);

    const run = this.runStore.create(taskId);
    this.taskService.setState(taskId, 'running');
    void this.drive(task, run, harness).catch(() => {});
    return run;
  }

  /** Kill the harness of a task's active run (task cancellation). */
  cancelForTask(taskId: number): void {
    for (const active of this.active.values()) {
      if (active.taskId === taskId) {
        this.runStore.finish(active.runId, 'cancelled');
        this.kill(active);
        this.events.onRunFinished?.(this.runStore.get(active.runId));
      }
    }
  }

  /** Kill every active harness (process shutdown). */
  shutdown(): void {
    for (const active of this.active.values()) this.kill(active);
    this.active.clear();
  }

  protected spawnHarness(
    task: TaskRow,
    harness: AppConfig['harnesses'][keyof AppConfig['harnesses']],
    cwd: string,
    extraEnv: Record<string, string>,
  ): ChildProcess {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...harness.env,
      // The Claude adapter refuses to start nested inside a Claude Code
      // session (spike finding); AgentDeck itself may have been launched
      // from one.
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
      ANTHROPIC_MODEL: task.model,
      AGENTDECK_MODEL: task.model,
      ...extraEnv,
    };
    return spawn(harness.command, harness.args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /** Hook for subclasses/slices: cwd and env for the run (worktree mode overrides). */
  protected async prepareWorkspace(task: TaskRow, _run: RunRow): Promise<{ cwd: string; env: Record<string, string> }> {
    return { cwd: task.workingDir, env: {} };
  }

  protected async afterRun(_task: TaskRow, _run: RunRow): Promise<void> {}

  private async drive(task: TaskRow, run: RunRow, harness: AppConfig['harnesses']['claude']): Promise<void> {
    const record = (type: 'session_update' | 'permission_request' | 'lifecycle', payload: unknown) => {
      const event = this.runStore.appendEvent(run.id, { type, payload });
      this.events.onRunEvent?.(event);
    };

    let child: ChildProcess;
    let workspace: { cwd: string; env: Record<string, string> };
    try {
      workspace = await this.prepareWorkspace(task, run);
      child = this.spawnHarness(task, harness, workspace.cwd, workspace.env);
    } catch (err) {
      this.settle(task, run, 'failed', err instanceof Error ? err.message : String(err));
      return;
    }

    const connection = new AcpConnection(child.stdin!, child.stdout!, {
      onSessionUpdate: (params) => record('session_update', params.update),
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') {
          const options = (params as any)?.options ?? [];
          const pick =
            options.find((o: any) => o.kind === 'allow_always') ??
            options.find((o: any) => o.kind === 'allow_once') ??
            options[0];
          const outcome = pick
            ? { outcome: 'selected', optionId: pick.optionId }
            : { outcome: 'cancelled' };
          record('permission_request', { request: params, outcome });
          return { outcome };
        }
        // Advertise no fs/terminal capabilities; anything else gets null.
        return null;
      },
    });

    const active: ActiveRun = { runId: run.id, taskId: task.id, child, connection };
    this.active.set(run.id, active);

    const exited = new Promise<never>((_, reject) => {
      child.on('error', (err) => reject(new Error(`harness spawn failed: ${err.message}`)));
      child.on('exit', (code, signal) =>
        reject(new Error(`harness exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) before finishing`)),
      );
    });

    try {
      await Promise.race([connection.request('initialize', { protocolVersion: 1, clientCapabilities: {} }), exited]);
      const session = (await Promise.race([
        connection.request('session/new', { cwd: workspace.cwd, mcpServers: [] }),
        exited,
      ])) as { sessionId: string };
      this.runStore.update(run.id, { sessionId: session.sessionId });

      const result = (await Promise.race([
        connection.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: task.prompt }],
        }),
        exited,
      ])) as { stopReason?: string; usage?: unknown };

      record('lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
      this.settle(task, run, 'completed', null, {
        stopReason: result.stopReason ?? null,
        usage: result.usage ? JSON.stringify(result.usage) : null,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.settle(task, run, 'failed', reason);
    } finally {
      connection.fail(new Error('run finished'));
      connection.dispose();
      this.active.delete(run.id);
      this.kill(active);
      try {
        await this.afterRun(task, this.runStore.get(run.id));
      } catch {
        // Workspace cleanup is best-effort.
      }
    }
  }

  private settle(
    task: TaskRow,
    run: RunRow,
    state: 'completed' | 'failed',
    reason: string | null,
    patch: Partial<RunRow> = {},
  ): void {
    // A run cancelled via cancelForTask stays cancelled; don't overwrite.
    const finished = this.runStore.finish(run.id, state, { ...patch, reason });
    // Only settle the task if it is still running — a cancel that raced
    // the harness's exit must win.
    if (this.taskService.get(task.id).state === 'running') {
      if (finished.state === 'completed') {
        this.taskService.setState(task.id, 'awaiting-review');
      } else if (finished.state === 'failed') {
        this.taskService.setState(task.id, 'failed');
      }
    }
    this.events.onRunFinished?.(finished);
  }

  private kill(active: ActiveRun): void {
    try {
      if (active.child.exitCode === null && !active.child.killed) active.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
