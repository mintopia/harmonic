import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, ne, and, or, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  workspaces,
  tasks,
  taskDependencies,
  taskChannels,
  runs,
  conversations,
  conversationEvents,
  trackerDismissals,
  type WorkspaceRow,
} from '../db/schema.js';
import { DomainError } from './errors.js';
import { deleteRunsAndChildren } from './run-cascade.js';
import {
  verificationCommandOverrideSchema,
  verificationCriticOverrideSchema,
  budgetGuardrailSchema,
} from '../config.js';

export const createWorkspaceInputSchema = z.object({
  name: z.string().min(1, 'name is required').meta({ example: 'Harmonic' }),
  workingDir: z.string().min(1, 'workingDir is required').meta({ example: '/home/dev/harmonic' }),
  /** Tracker mirroring for this Workspace (issue #45); off by default. */
  trackerEnabled: z.boolean().optional().meta({ example: false }),
  /** How often this Workspace's poll loop scans its repo, in seconds. */
  trackerPollIntervalSeconds: z.number().int().min(5).optional().meta({ example: 60 }),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

/**
 * Per-workspace setting overrides (ADR-0012, issues #59/#64). Each is nullable:
 * `null` clears the override back to *inherit* the global default, an explicit
 * value overrides it, and an omitted (`undefined`) field is left untouched. The
 * Workspace settings page (#64) writes these through PATCH; the values are
 * consumed at read time (#60) — this schema only carries them.
 */
export const workspaceOverridesSchema = z.object({
  harness: z.string().min(1).nullable().optional().meta({ example: 'codex' }),
  model: z.string().min(1).nullable().optional().meta({ example: 'gpt-5' }),
  /** Chat-default Harness override; null inherits `config.chat.harness`. */
  chatHarness: z.string().min(1).nullable().optional().meta({ example: 'codex' }),
  /** Chat-default model override; null inherits `config.chat.model`. */
  chatModel: z.string().min(1).nullable().optional().meta({ example: 'gpt-5.6-sol' }),
  isolationMode: z.enum(['direct', 'worktree']).nullable().optional().meta({ example: 'worktree' }),
  priority: z.enum(['high', 'normal', 'low']).nullable().optional().meta({ example: 'high' }),
  maxConcurrentRuns: z.number().int().min(1).nullable().optional().meta({ example: 2 }),
  autoRunnerEnabled: z.boolean().nullable().optional().meta({ example: true }),
  /**
   * Command-verifier override (issue #132), tri-state (issue #174): null/absent
   * inherits `config.verification.command`, a verifier object overrides it, and
   * `{ off: true }` explicitly disables the verifier for this Workspace.
   */
  verificationCommand: verificationCommandOverrideSchema.nullable().optional(),
  /**
   * Critic-verifier override (issue #132), tri-state (issue #174): null/absent
   * inherits `config.verification.critic`, a verifier object overrides it, and
   * `{ off: true }` explicitly disables the verifier for this Workspace.
   */
  verificationCritic: verificationCriticOverrideSchema.nullable().optional(),
  /** Auto-accept override (issue #138); null inherits `config.verification.autoAccept`. */
  verificationAutoAccept: z.boolean().nullable().optional().meta({ example: true }),
  /** Budget-Guardrail override (issue #126); null inherits `config.guardrails.budget`. */
  guardrailBudget: budgetGuardrailSchema.nullable().optional(),
  /** Progress-detector toggle override (issue #126); null inherits `config.guardrails.progress`. */
  guardrailProgress: z.boolean().nullable().optional(),
});

export const updateWorkspaceInputSchema = createWorkspaceInputSchema
  .partial()
  .extend(workspaceOverridesSchema.shape);
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInputSchema>;

/**
 * The given Workspace, or the earliest-created one when `id` is omitted —
 * the shared "default Workspace" fallback (ADR-0008) that keeps callers who
 * predate Workspaces (MCP, older API clients) working unchanged. Shared by
 * `WorkspaceService.resolve` and `TaskService` (which only holds a
 * `getWorkspaces` closure, not the service itself) so the rule lives once.
 */
export function resolveWorkspace(list: WorkspaceRow[], id?: number): WorkspaceRow {
  if (id === undefined) {
    const first = list[0];
    if (!first) throw new DomainError('validation', 'no workspace exists');
    return first;
  }
  const found = list.find((w) => w.id === id);
  if (!found) throw new DomainError('validation', `workspace ${id} not found`);
  return found;
}

/**
 * A Workspace (ADR-0008): a named Working Directory, unique by absolute
 * path, with its own tracker mirroring settings (issue #45). Full CRUD;
 * {@link delete} cascades its board and is guarded against removing the last
 * Workspace or one with a running Task.
 */
export class WorkspaceService {
  constructor(private readonly db: Db) {}

  list(): WorkspaceRow[] {
    return this.db.select().from(workspaces).orderBy(workspaces.createdAt).all();
  }

  get(id: number): WorkspaceRow {
    const row = this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    if (!row) throw new DomainError('not_found', `workspace ${id} not found`);
    return row;
  }

  /** {@link resolveWorkspace} over the current list — see its doc comment. */
  resolve(id?: number): WorkspaceRow {
    return resolveWorkspace(this.list(), id);
  }

  create(input: CreateWorkspaceInput): WorkspaceRow {
    const workingDir = this.assertUsableDir(input.workingDir);
    this.assertUniquePath(workingDir);
    const now = Date.now();
    return this.db
      .insert(workspaces)
      .values({
        name: input.name,
        workingDir,
        trackerEnabled: input.trackerEnabled ?? false,
        trackerPollIntervalSeconds: input.trackerPollIntervalSeconds ?? 60,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  update(id: number, input: UpdateWorkspaceInput): WorkspaceRow {
    const current = this.get(id);
    const workingDir = input.workingDir !== undefined ? this.assertUsableDir(input.workingDir) : current.workingDir;
    if (workingDir !== current.workingDir) this.assertUniquePath(workingDir, id);
    // Overridable settings are nullable, so `null` (clear to inherit) and
    // `undefined` (field omitted) mean different things: `?? current` would
    // wrongly treat a clear as a keep. `patch` keeps a field only when it is
    // genuinely absent, letting a null through as an explicit inherit.
    const patch = <T>(next: T | null | undefined, kept: T | null): T | null => (next === undefined ? kept : next);
    // Verifier overrides are object-valued but stored as JSON text: undefined keeps
    // the current column, null clears to inherit, an object is serialised.
    const patchJson = <T>(next: T | null | undefined, kept: string | null): string | null =>
      next === undefined ? kept : next === null ? null : JSON.stringify(next);
    return this.db
      .update(workspaces)
      .set({
        name: input.name ?? current.name,
        workingDir,
        trackerEnabled: input.trackerEnabled ?? current.trackerEnabled,
        trackerPollIntervalSeconds: input.trackerPollIntervalSeconds ?? current.trackerPollIntervalSeconds,
        harness: patch(input.harness, current.harness),
        model: patch(input.model, current.model),
        chatHarness: patch(input.chatHarness, current.chatHarness),
        chatModel: patch(input.chatModel, current.chatModel),
        isolationMode: patch(input.isolationMode, current.isolationMode),
        priority: patch(input.priority, current.priority),
        maxConcurrentRuns: patch(input.maxConcurrentRuns, current.maxConcurrentRuns),
        autoRunnerEnabled: patch(input.autoRunnerEnabled, current.autoRunnerEnabled),
        verificationCommand: patchJson(input.verificationCommand, current.verificationCommand),
        verificationCritic: patchJson(input.verificationCritic, current.verificationCritic),
        verificationAutoAccept: patch(input.verificationAutoAccept, current.verificationAutoAccept),
        guardrailBudget: patchJson(input.guardrailBudget, current.guardrailBudget),
        guardrailProgress: patch(input.guardrailProgress, current.guardrailProgress),
        updatedAt: Date.now(),
      })
      .where(eq(workspaces.id, id))
      .returning()
      .get()!;
  }

  /**
   * Delete a Workspace and everything on its board (issue #45 needs deletion to
   * tear down its poll loop). Refuses any Workspace with a running Task (the
   * mid-run guard #42 deferred deletion for). Deleting the last Workspace is
   * allowed (issue #61): the app lands in the empty state (#68), and the
   * default-Workspace fallback (ADR-0008) resolves the next one created.
   * Cascades in a transaction: its Tasks (+ their Runs, Run events, Dependency
   * edges, Channel links) and Conversations (+ their events) go first, since no
   * FK declares ON DELETE CASCADE.
   */
  delete(id: number): void {
    this.get(id); // 404 if missing
    const running = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, id), eq(tasks.state, 'running')))
      .get();
    if (running) throw new DomainError('conflict', `workspace ${id} has a running task; stop it first`);
    const taskIds = this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, id)).all().map((r) => r.id);
    const convIds = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.workspaceId, id))
      .all()
      .map((r) => r.id);
    this.db.transaction((tx) => {
      if (taskIds.length > 0) {
        const runIds = tx.select({ id: runs.id }).from(runs).where(inArray(runs.taskId, taskIds)).all().map((r) => r.id);
        // Purge the whole Run tree (every FK-to-runs child), not just run_events —
        // shared with TaskService.delete so the run-child set is enumerated once (issue #162).
        deleteRunsAndChildren(tx, runIds);
        tx.delete(taskChannels).where(inArray(taskChannels.taskId, taskIds)).run();
        tx.delete(taskDependencies)
          .where(or(inArray(taskDependencies.taskId, taskIds), inArray(taskDependencies.dependsOnId, taskIds)))
          .run();
        tx.delete(tasks).where(inArray(tasks.id, taskIds)).run();
      }
      if (convIds.length > 0) {
        tx.delete(conversationEvents).where(inArray(conversationEvents.conversationId, convIds)).run();
        tx.delete(conversations).where(inArray(conversations.id, convIds)).run();
      }
      // Dismissal tombstones (issue #162) are FK-bound to the Workspace, so they
      // must go before the row they reference or foreign_keys=ON rejects the delete.
      tx.delete(trackerDismissals).where(eq(trackerDismissals.workspaceId, id)).run();
      tx.delete(workspaces).where(eq(workspaces.id, id)).run();
    });
  }

  /** Resolves to an absolute path and rejects one that isn't a real, existing directory. */
  private assertUsableDir(workingDir: string): string {
    const resolved = resolve(workingDir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new DomainError('validation', `working directory '${workingDir}' does not exist`);
    }
    return resolved;
  }

  private assertUniquePath(workingDir: string, excludeId?: number): void {
    const filters = [eq(workspaces.workingDir, workingDir)];
    if (excludeId !== undefined) filters.push(ne(workspaces.id, excludeId));
    const clash = this.db
      .select()
      .from(workspaces)
      .where(and(...filters))
      .get();
    if (clash) throw new DomainError('conflict', `a workspace already uses '${workingDir}'`);
  }
}
