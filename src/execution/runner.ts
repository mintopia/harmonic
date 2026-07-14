import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';
import { adapterFor } from './harness/adapter.js';
import { collectUsage, collectUsageWithRetry, type RunUsage } from './usage.js';
import type { AppConfig, HarnessConfig } from '../config.js';
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

export interface RunnerOptions {
  events?: RunnerEvents;
  /** Where temporary worktrees live; per-run subdirectories. */
  worktreesDir?: string;
  /** Mints/revokes the per-run scoped API key injected into the harness. */
  keys?: {
    mint: (runId: number) => string;
    revoke: (runId: number) => void;
  };
}

interface Workspace {
  cwd: string;
  env: Record<string, string>;
  worktree?: { repoDir: string; path: string };
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

  private readonly events: RunnerEvents;
  private readonly worktreesDir: string;
  private readonly keys: RunnerOptions['keys'];
  /** The MCP endpoint agents should call back to; set once the server listens. */
  mcpUrl: string | null = null;

  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly getConfig: () => AppConfig,
    options: RunnerOptions = {},
  ) {
    this.events = options.events ?? {};
    this.worktreesDir = options.worktreesDir ?? join(tmpdir(), 'agentdeck-worktrees');
    this.keys = options.keys;
  }

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

  private spawnHarness(
    task: TaskRow,
    harness: HarnessConfig,
    cwd: string,
    extraEnv: Record<string, string>,
  ): ChildProcess {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...harness.env,
      AGENTDECK_MODEL: task.model,
      ...adapterFor(task.harness).spawnEnv(task.model),
      ...extraEnv,
    };
    return spawn(harness.command, harness.args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /**
   * Direct mode runs in place, unlocked. Worktree mode gets a temporary
   * git worktree on branch `agentdeck/task-<id>-run-<n>` cut from the
   * working directory's current branch.
   */
  private async prepareWorkspace(task: TaskRow, run: RunRow): Promise<Workspace> {
    if (task.isolationMode !== 'worktree') return { cwd: task.workingDir, env: {} };

    const baseBranch = await Git.currentBranch(task.workingDir);
    const branch = `agentdeck/task-${task.id}-run-${run.attempt}`;
    const path = join(this.worktreesDir, `run-${run.id}`);
    mkdirSync(this.worktreesDir, { recursive: true });
    await Git.addWorktree(task.workingDir, path, branch);
    this.runStore.update(run.id, { branch, baseBranch });
    return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path } };
  }

  /**
   * Snapshot the run's work onto its branch and drop the worktree; the
   * branch remains as the artifact. Runs before the task settles so an
   * awaiting-review task always has a reviewable branch.
   */
  private async finalizeWorkspace(task: TaskRow, run: RunRow, workspace: Workspace): Promise<void> {
    if (!workspace.worktree) return;
    try {
      await Git.commitAll(workspace.worktree.path, `agentdeck: task ${task.id} run ${run.attempt}`);
    } finally {
      await Git.removeWorktree(workspace.worktree.repoDir, workspace.worktree.path).catch(() => {});
    }
  }

  private async drive(task: TaskRow, run: RunRow, harness: HarnessConfig): Promise<void> {
    const record = (type: 'session_update' | 'permission_request' | 'lifecycle', payload: unknown) => {
      const event = this.runStore.appendEvent(run.id, { type, payload });
      this.events.onRunEvent?.(event);
    };

    let child: ChildProcess;
    let workspace: Workspace;
    try {
      workspace = await this.prepareWorkspace(task, run);
      // Agents reach the MCP server with zero setup: a scoped key (its
      // lifetime follows the run's) plus the endpoint, in the environment.
      if (this.keys && this.mcpUrl) {
        workspace.env.AGENTDECK_API_KEY = this.keys.mint(run.id);
        workspace.env.AGENTDECK_MCP_URL = this.mcpUrl;
      }
      child = this.spawnHarness(task, harness, workspace.cwd, workspace.env);
    } catch (err) {
      // The Run Key may already be minted; it must not outlive the run.
      try {
        this.keys?.revoke(run.id);
      } catch {
        // Best-effort; the startup sweep is the backstop.
      }
      this.settle(task, run, 'failed', err instanceof Error ? err.message : String(err));
      return;
    }

    let finalized = false;
    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      this.kill(active);
      try {
        this.keys?.revoke(run.id);
      } catch {
        // Revocation is best-effort; keys also die with the database row.
      }
      await this.finalizeWorkspace(task, run, workspace).catch(() => {});
    };

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
      ])) as { stopReason?: string; usage?: Record<string, unknown> };

      record('lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
      await finalize();
      this.settle(task, run, 'completed', null, {
        stopReason: result.stopReason ?? null,
        usage: await this.collectUsageSafe(task, run, harness, workspace, result),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await finalize();
      this.settle(task, run, 'failed', reason, {
        usage: await this.collectUsageSafe(task, run, harness, workspace, undefined),
      });
    } finally {
      connection.fail(new Error('run finished'));
      connection.dispose();
      this.active.delete(run.id);
      await finalize();
    }
  }

  /** Usage is decoration on a finished run — never let it fail the run. */
  private async collectUsageSafe(
    task: TaskRow,
    run: RunRow,
    harness: HarnessConfig,
    workspace: Workspace,
    promptResult: { stopReason?: string; usage?: Record<string, unknown> } | undefined,
  ): Promise<string | null> {
    try {
      const usage = await collectUsageWithRetry({
        harnessId: task.harness,
        harness,
        cwd: workspace.cwd,
        sessionId: this.runStore.get(run.id).sessionId,
        promptResult,
        events: this.runStore.listEvents(run.id),
      });
      return usage ? JSON.stringify(usage) : null;
    } catch {
      return null;
    }
  }

  /**
   * Boot-time healing for the same race: finished runs whose stored
   * usage has no per-model split get one more read of the (now settled)
   * session log. Stored ACP totals win over re-derived ones.
   */
  backfillUsage(): void {
    const config = this.getConfig();
    for (const run of this.runStore.listUsageBackfillCandidates()) {
      try {
        const task = this.taskService.get(run.taskId);
        const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
        if (!harness) continue;
        // Worktree runs executed (and logged) under the worktree path;
        // the directory is gone but the log slug derives from the string.
        const cwd = run.branch ? join(this.worktreesDir, `run-${run.id}`) : task.workingDir;
        const fresh = collectUsage({
          harnessId: task.harness,
          harness,
          cwd,
          sessionId: run.sessionId,
          events: this.runStore.listEvents(run.id),
        });
        if (!fresh || Object.keys(fresh.models).length === 0) continue;
        const stored = run.usage ? (JSON.parse(run.usage) as RunUsage) : null;
        const healed: RunUsage = stored?.totals
          ? { ...fresh, totals: stored.totals, source: 'combined' }
          : fresh;
        this.runStore.update(run.id, { usage: JSON.stringify(healed) });
      } catch {
        // Healing is best-effort; the run keeps its stored usage.
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
