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
  conversations,
  conversationEvents,
  trackerDismissals,
  type WorkspaceRow,
  type WorkspaceIdentityRow,
} from '../db/schema.js';
import { DomainError } from './errors.js';
import { deleteAttemptsAndChildrenAsync } from './attempt-cascade.js';
import {
  verificationCommandOverrideSchema,
  budgetGuardrailSchema,
  MERGE_FATES,
  HARNESS_IDS,
} from '../config.js';

export const createWorkspaceInputSchema = z.object({
  name: z.string().min(1, 'name is required').meta({ example: 'Harmonic' }),
  workingDir: z.string().min(1, 'workingDir is required').meta({ example: '/home/dev/harmonic' }),
  /** Tracker mirroring for this Workspace; off by default. */
  trackerEnabled: z.boolean().optional().meta({ example: false }),
  /** How often this Workspace's poll loop scans its repo, in seconds. */
  trackerPollIntervalSeconds: z.number().int().min(5).optional().meta({ example: 60 }),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

/**
 * Per-workspace setting overrides. Each is nullable: `null` clears the override
 * back to inherit the global default, an explicit value overrides it, and an
 * omitted (`undefined`) field is left untouched.
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
  /** Conflict-resolve-turn bound override; null inherits `config.defaults.conflictResolveTurns`. */
  conflictResolveTurns: z.number().int().min(0).nullable().optional().meta({ example: 2 }),
  maxConcurrentAttempts: z.number().int().min(1).nullable().optional().meta({ example: 2 }),
  autoRunnerEnabled: z.boolean().nullable().optional().meta({ example: true }),
  maxAttempts: z.number().int().min(1).nullable().optional().meta({ example: 2 }),
  contextReuseTokenLimit: z.number().int().min(0).nullable().optional().meta({ example: 200_000 }),
  /**
   * Command-verifier override, list-grain: null/absent inherits
   * `config.verify.commands`, a non-empty array overrides the whole list, and an
   * explicit empty array `[]` runs no commands here.
   */
  verificationCommand: verificationCommandOverrideSchema.nullable().optional(),
  /**
   * Critic-review override, decomposed into four independently-inheritable
   * scalars: null/absent inherits the matching global `config.verify.review.*`.
   */
  reviewEnabled: z.boolean().nullable().optional().meta({ example: true }),
  reviewPrompt: z.string().min(1).nullable().optional().meta({ example: 'Review the diff for correctness.' }),
  reviewModel: z.string().min(1).nullable().optional().meta({ example: 'claude-opus-5' }),
  reviewHarness: z.enum(HARNESS_IDS).nullable().optional().meta({ example: 'claude' }),
  /** Budget-Guardrail override; null inherits `config.guardrails.budget`. */
  guardrailBudget: budgetGuardrailSchema.nullable().optional(),
  /** Progress-detector toggle override; null inherits `config.guardrails.progress`. */
  guardrailProgress: z.boolean().nullable().optional(),
  /** Tool-timeout bound override; null inherits `config.guardrails.toolTimeoutMinutes`. */
  toolTimeoutMinutes: z.number().positive().nullable().optional().meta({ example: 20 }),
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
export type WorkspaceOverrides = z.infer<typeof workspaceOverridesSchema>;

/** Every per-Workspace setting override key. */
export const OVERRIDE_KEYS = [
  'harness',
  'model',
  'chatHarness',
  'chatModel',
  'isolationMode',
  'priority',
  'conflictResolveTurns',
  'maxConcurrentAttempts',
  'autoRunnerEnabled',
  'maxAttempts',
  'contextReuseTokenLimit',
  'verificationCommand',
  'reviewEnabled',
  'reviewPrompt',
  'reviewModel',
  'reviewHarness',
  'guardrailBudget',
  'guardrailProgress',
  'toolTimeoutMinutes',
  'drivePrompt',
  'driveUnattendedReminder',
  'driveContinuePrompt',
  'driveMergeFate',
  'driveContinueAttempts',
  'taskPrompt',
] as const;

/** A fully-populated overrides object: every key present, `null` meaning
 * *inherit* the global default — what `SettingsStore.getOverrides` returns. */
export type ResolvedOverrides = { [K in (typeof OVERRIDE_KEYS)[number]]: NonNullable<WorkspaceOverrides[K]> | null };

export interface WorkspaceSettingsStore {
  getOverrides(workspaceId: number): ResolvedOverrides;
  setOverrides(workspaceId: number, patch: WorkspaceOverrides): Promise<void>;
  deleteOverrides(workspaceId: number): Promise<void>;
}

export const updateWorkspaceInputSchema = createWorkspaceInputSchema
  .partial()
  .extend(workspaceOverridesSchema.shape);
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInputSchema>;

/** The given Workspace, or the earliest-created one when `id` is omitted — the default-Workspace fallback. */
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
 * A Workspace: a named Working Directory, unique by absolute path, with its
 * own tracker mirroring settings. Full CRUD; {@link delete} cascades its board
 * and is guarded against removing one with a running Task.
 */
export class WorkspaceService {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly settings: WorkspaceSettingsStore,
  ) {}

  private compose(row: WorkspaceIdentityRow): WorkspaceRow {
    const o = this.settings.getOverrides(row.id);
    return {
      ...row,
      harness: o.harness,
      model: o.model,
      chatHarness: o.chatHarness,
      chatModel: o.chatModel,
      isolationMode: o.isolationMode,
      priority: o.priority,
      conflictResolveTurns: o.conflictResolveTurns,
      maxConcurrentAttempts: o.maxConcurrentAttempts,
      autoRunnerEnabled: o.autoRunnerEnabled,
      maxAttempts: o.maxAttempts,
      contextReuseTokenLimit: o.contextReuseTokenLimit,
      verificationCommand: o.verificationCommand != null ? JSON.stringify(o.verificationCommand) : null,
      reviewEnabled: o.reviewEnabled,
      reviewPrompt: o.reviewPrompt,
      reviewModel: o.reviewModel,
      reviewHarness: o.reviewHarness,
      guardrailBudget: o.guardrailBudget != null ? JSON.stringify(o.guardrailBudget) : null,
      guardrailProgress: o.guardrailProgress,
      toolTimeoutMinutes: o.toolTimeoutMinutes,
      drivePrompt: o.drivePrompt,
      driveUnattendedReminder: o.driveUnattendedReminder,
      driveContinuePrompt: o.driveContinuePrompt,
      driveMergeFate: o.driveMergeFate,
      driveContinueAttempts: o.driveContinueAttempts,
      taskPrompt: o.taskPrompt,
    };
  }

  async list(): Promise<WorkspaceRow[]> {
    const rows = await this.db.read((db) => db.select().from(workspaces).orderBy(workspaces.createdAt).all());
    return rows.map((r) => this.compose(r));
  }

  async get(id: number): Promise<WorkspaceRow> {
    const row = await this.db.read((db) => db.select().from(workspaces).where(eq(workspaces.id, id)).get());
    if (!row) throw new DomainError('not_found', `workspace ${id} not found`);
    return this.compose(row);
  }

  async assertExists(id: number): Promise<void> {
    await this.get(id);
  }

  /** {@link resolveWorkspace} over the current list. */
  async resolve(id?: number): Promise<WorkspaceRow> {
    return resolveWorkspace(await this.list(), id);
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    const workingDir = this.assertUsableDir(input.workingDir);
    await this.assertUniquePath(workingDir);
    const now = Date.now();
    const inserted = await this.db.write((db) =>
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
    return this.compose(inserted);
  }

  async update(id: number, input: UpdateWorkspaceInput): Promise<WorkspaceRow> {
    const current = await this.get(id);
    const workingDir = input.workingDir !== undefined ? this.assertUsableDir(input.workingDir) : current.workingDir;
    if (workingDir !== current.workingDir) await this.assertUniquePath(workingDir, id);
    const identityRow = await this.db.write((db) =>
      db
        .update(workspaces)
        .set({
          name: input.name ?? current.name,
          workingDir,
          trackerEnabled: input.trackerEnabled ?? current.trackerEnabled,
          trackerPollIntervalSeconds: input.trackerPollIntervalSeconds ?? current.trackerPollIntervalSeconds,
          updatedAt: Date.now(),
        })
        .where(eq(workspaces.id, id))
        .returning()
        .get(),
    );
    const { name: _name, workingDir: _workingDir, trackerEnabled: _trackerEnabled, trackerPollIntervalSeconds: _trackerPollIntervalSeconds, ...overridesPatch } = input;
    await this.settings.setOverrides(id, overridesPatch);
    return this.compose(identityRow!);
  }

  /**
   * Delete a Workspace and everything on its board. Refuses any Workspace with
   * a running Task. Deleting the last Workspace is allowed. Cascades in a
   * transaction: its Tasks (+ Attempts, Attempt events, Dependency edges,
   * Channel links) and Conversations (+ events) go first.
   */
  async delete(id: number): Promise<void> {
    await this.get(id);
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
        await deleteAttemptsAndChildrenAsync(tx, taskIds);
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
      await tx.delete(trackerDismissals).where(eq(trackerDismissals.workspaceId, id)).run();
      await tx.delete(workspaces).where(eq(workspaces.id, id)).run();
    });
    await this.settings.deleteOverrides(id);
  }

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
