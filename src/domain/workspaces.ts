import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, ne, and, or, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AsyncDbHandle } from '../db/async.js';
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
import { deleteRunsAndChildrenAsync } from './run-cascade.js';
import {
  verificationCommandOverrideSchema,
  budgetGuardrailSchema,
  MERGE_FATES,
  HARNESS_IDS,
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
  /** Integration-retry bound (ADR-0046) override; null inherits `config.defaults.integrationRetries`. */
  integrationRetries: z.number().int().min(1).nullable().optional().meta({ example: 5 }),
  /** Conflict-resolve-turn bound (ADR-0046) override; null inherits `config.defaults.conflictResolveTurns`. */
  conflictResolveTurns: z.number().int().min(0).nullable().optional().meta({ example: 2 }),
  maxConcurrentRuns: z.number().int().min(1).nullable().optional().meta({ example: 2 }),
  autoRunnerEnabled: z.boolean().nullable().optional().meta({ example: true }),
  maxAttempts: z.number().int().min(1).nullable().optional().meta({ example: 2 }),
  contextReuseTokenLimit: z.number().int().min(0).nullable().optional().meta({ example: 200_000 }),
  /**
   * Command-verifier override (issue #132), list-grain (ADR-0044 §D, issue #338):
   * null/absent inherits `config.verify.commands`, a non-empty array overrides the
   * whole list, and an explicit empty array `[]` runs no commands here (off). No
   * per-command inheritance, no `{ off: true }` sentinel.
   */
  verificationCommand: verificationCommandOverrideSchema.nullable().optional(),
  /**
   * Critic-review override (issue #337, ADR-0044 §C), decomposed into four
   * independently-inheritable scalars: null/absent inherits the matching global
   * `config.verify.review.*`, a value overrides it. "Off" is `reviewEnabled:false`.
   */
  reviewEnabled: z.boolean().nullable().optional().meta({ example: true }),
  reviewPrompt: z.string().min(1).nullable().optional().meta({ example: 'Review the diff for correctness.' }),
  reviewModel: z.string().min(1).nullable().optional().meta({ example: 'claude-opus-5' }),
  reviewHarness: z.enum(HARNESS_IDS).nullable().optional().meta({ example: 'claude' }),
  /** Budget-Guardrail override (issue #126); null inherits `config.guardrails.budget`. */
  guardrailBudget: budgetGuardrailSchema.nullable().optional(),
  /** Progress-detector toggle override (issue #126); null inherits `config.guardrails.progress`. */
  guardrailProgress: z.boolean().nullable().optional(),
  /** Tool-timeout bound override (ADR-0044); null inherits `config.guardrails.toolTimeoutMinutes`. */
  toolTimeoutMinutes: z.number().positive().nullable().optional().meta({ example: 20 }),
  // Drive.* overrides (ADR-0044): five independently-inheritable fields. Each is
  // nullable — null clears back to inherit the matching `config.drive.*` default.
  /** Drive Prompt override; null inherits `config.drive.prompt`. */
  drivePrompt: z.string().min(1).nullable().optional(),
  /** Unattended-reminder override; null inherits `config.drive.unattendedReminder`. */
  driveUnattendedReminder: z.string().min(1).nullable().optional(),
  /** Continue-prompt override; null inherits `config.drive.continuePrompt`. */
  driveContinuePrompt: z.string().min(1).nullable().optional(),
  /** Merge Fate override; null inherits `config.drive.mergeFate`. */
  driveMergeFate: z.enum(MERGE_FATES).nullable().optional().meta({ example: 'auto-merge' }),
  /** Continue-attempts override; null inherits `config.drive.continueAttempts`. */
  driveContinueAttempts: z.number().int().min(0).nullable().optional().meta({ example: 1 }),
  /** Task Prompt override; null inherits `config.taskPrompt`. */
  taskPrompt: z.string().min(1).nullable().optional(),
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
  constructor(private readonly db: AsyncDbHandle) {}

  list(): Promise<WorkspaceRow[]> {
    return this.db.read((db) => db.select().from(workspaces).orderBy(workspaces.createdAt).all());
  }

  async get(id: number): Promise<WorkspaceRow> {
    const row = await this.db.read((db) => db.select().from(workspaces).where(eq(workspaces.id, id)).get());
    if (!row) throw new DomainError('not_found', `workspace ${id} not found`);
    return row;
  }

  async assertExists(id: number): Promise<void> {
    await this.get(id);
  }

  /** {@link resolveWorkspace} over the current list — see its doc comment. */
  async resolve(id?: number): Promise<WorkspaceRow> {
    return resolveWorkspace(await this.list(), id);
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    const workingDir = this.assertUsableDir(input.workingDir);
    await this.assertUniquePath(workingDir);
    const now = Date.now();
    return this.db.write((db) =>
      db
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
        .get(),
    );
  }

  async update(id: number, input: UpdateWorkspaceInput): Promise<WorkspaceRow> {
    const current = await this.get(id);
    const workingDir = input.workingDir !== undefined ? this.assertUsableDir(input.workingDir) : current.workingDir;
    if (workingDir !== current.workingDir) await this.assertUniquePath(workingDir, id);
    // Overridable settings are nullable, so `null` (clear to inherit) and
    // `undefined` (field omitted) mean different things: `?? current` would
    // wrongly treat a clear as a keep. `patch` keeps a field only when it is
    // genuinely absent, letting a null through as an explicit inherit.
    const patch = <T>(next: T | null | undefined, kept: T | null): T | null => (next === undefined ? kept : next);
    // Verifier overrides are object-valued but stored as JSON text: undefined keeps
    // the current column, null clears to inherit, an object is serialised.
    const patchJson = <T>(next: T | null | undefined, kept: string | null): string | null =>
      next === undefined ? kept : next === null ? null : JSON.stringify(next);
    return this.db.write(async (db) => {
      const row = await db
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
          integrationRetries: patch(input.integrationRetries, current.integrationRetries),
          conflictResolveTurns: patch(input.conflictResolveTurns, current.conflictResolveTurns),
          maxConcurrentRuns: patch(input.maxConcurrentRuns, current.maxConcurrentRuns),
          autoRunnerEnabled: patch(input.autoRunnerEnabled, current.autoRunnerEnabled),
          maxAttempts: patch(input.maxAttempts, current.maxAttempts),
          contextReuseTokenLimit: patch(input.contextReuseTokenLimit, current.contextReuseTokenLimit),
          verificationCommand: patchJson(input.verificationCommand, current.verificationCommand),
          reviewEnabled: patch(input.reviewEnabled, current.reviewEnabled),
          reviewPrompt: patch(input.reviewPrompt, current.reviewPrompt),
          reviewModel: patch(input.reviewModel, current.reviewModel),
          reviewHarness: patch(input.reviewHarness, current.reviewHarness),
          guardrailBudget: patchJson(input.guardrailBudget, current.guardrailBudget),
          guardrailProgress: patch(input.guardrailProgress, current.guardrailProgress),
          toolTimeoutMinutes: patch(input.toolTimeoutMinutes, current.toolTimeoutMinutes),
          drivePrompt: patch(input.drivePrompt, current.drivePrompt),
          driveUnattendedReminder: patch(input.driveUnattendedReminder, current.driveUnattendedReminder),
          driveContinuePrompt: patch(input.driveContinuePrompt, current.driveContinuePrompt),
          driveMergeFate: patch(input.driveMergeFate, current.driveMergeFate),
          driveContinueAttempts: patch(input.driveContinueAttempts, current.driveContinueAttempts),
          taskPrompt: patch(input.taskPrompt, current.taskPrompt),
          updatedAt: Date.now(),
        })
        .where(eq(workspaces.id, id))
        .returning()
        .get();
      return row!;
    });
  }

  /**
   * Delete a Workspace and everything on its board (issue #45 needs deletion to
   * tear down its poll loop). Refuses any Workspace with a running Task (the
   * mid-run guard #42 deferred deletion for). Deleting the last Workspace is
   * allowed (issue #61): the app merges in the empty state (#68), and the
   * default-Workspace fallback (ADR-0008) resolves the next one created.
   * Cascades in a transaction: its Tasks (+ their Runs, Run events, Dependency
   * edges, Channel links) and Conversations (+ their events) go first, since no
   * FK declares ON DELETE CASCADE.
   */
  async delete(id: number): Promise<void> {
    await this.get(id); // 404 if missing
    const running = await this.db.read((db) =>
      db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, id), eq(tasks.state, 'working')))
        .get(),
    );
    if (running) throw new DomainError('conflict', `workspace ${id} has a running task; stop it first`);
    const taskIds = (
      await this.db.read((db) => db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, id)).all())
    ).map((r) => r.id);
    const convIds = (
      await this.db.read((db) =>
        db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, id)).all(),
      )
    ).map((r) => r.id);
    await this.db.transaction(async (tx) => {
      if (taskIds.length > 0) {
        const runIds = (await tx.select({ id: runs.id }).from(runs).where(inArray(runs.taskId, taskIds)).all()).map(
          (r) => r.id,
        );
        // Purge the whole Run tree (every FK-to-runs child), not just run_events —
        // shared with TaskService.delete so the run-child set is enumerated once (issue #162).
        await deleteRunsAndChildrenAsync(tx, runIds);
        await tx.delete(taskChannels).where(inArray(taskChannels.taskId, taskIds)).run();
        await tx
          .delete(taskDependencies)
          .where(or(inArray(taskDependencies.taskId, taskIds), inArray(taskDependencies.dependsOnId, taskIds)))
          .run();
        await tx.delete(tasks).where(inArray(tasks.id, taskIds)).run();
      }
      if (convIds.length > 0) {
        await tx.delete(conversationEvents).where(inArray(conversationEvents.conversationId, convIds)).run();
        await tx.delete(conversations).where(inArray(conversations.id, convIds)).run();
      }
      // Dismissal tombstones (issue #162) are FK-bound to the Workspace, so they
      // must go before the row they reference or foreign_keys=ON rejects the delete.
      await tx.delete(trackerDismissals).where(eq(trackerDismissals.workspaceId, id)).run();
      await tx.delete(workspaces).where(eq(workspaces.id, id)).run();
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

  private async assertUniquePath(workingDir: string, excludeId?: number): Promise<void> {
    const filters = [eq(workspaces.workingDir, workingDir)];
    if (excludeId !== undefined) filters.push(ne(workspaces.id, excludeId));
    const clash = await this.db.read((db) =>
      db
        .select()
        .from(workspaces)
        .where(and(...filters))
        .get(),
    );
    if (clash) throw new DomainError('conflict', `a workspace already uses '${workingDir}'`);
  }
}
