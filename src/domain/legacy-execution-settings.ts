import { z } from 'zod';
import {
  overlayEntrySchema,
  verificationCommandOverrideSchema,
  verificationCriticIdentitySchema,
  verificationStageSchema,
  type VerificationCommand,
} from '../config.js';
import { mergeOverlay } from './setting-override.js';

export const MERGE_FATES = ['auto-merge', 'open-PR', 'artifact'] as const;
export type MergeFate = (typeof MERGE_FATES)[number];

export const taskVerificationCriticSchema = verificationCriticIdentitySchema.extend({
  issuePrompt: z.string().min(1),
  noIssuePrompt: z.string().min(1),
});
export type TaskVerificationCritic = z.infer<typeof taskVerificationCriticSchema>;

const taskVerificationCriticOverrideSchema = z.array(overlayEntrySchema('critic', taskVerificationCriticSchema));
const taskVerificationStageSchema = verificationStageSchema(taskVerificationCriticSchema);
const partialTaskStageSchema = taskVerificationStageSchema.partial();
export type TaskVerificationStage = z.infer<typeof taskVerificationStageSchema>;

const legacyGlobalSchema = z.object({
  drive: z.object({ mergeFate: z.enum(MERGE_FATES), continueAttempts: z.number().int().min(0) }).partial().optional(),
  verify: z.object({ task: z.object({ preMerge: partialTaskStageSchema, postMerge: partialTaskStageSchema }).partial().optional() }).optional(),
});

const legacyWorkspaceSchema = z.object({
  taskPreMergeCommands: verificationCommandOverrideSchema.nullable().optional(),
  taskPreMergeCritics: taskVerificationCriticOverrideSchema.nullable().optional(),
  taskPostMergeCommands: verificationCommandOverrideSchema.nullable().optional(),
  taskPostMergeCritics: taskVerificationCriticOverrideSchema.nullable().optional(),
  driveMergeFate: z.enum(MERGE_FATES).nullable().optional(),
  driveContinueAttempts: z.number().int().min(0).nullable().optional(),
});

export type LegacyGlobalPatch = z.input<typeof legacyGlobalSchema>;
export type LegacyWorkspacePatch = z.input<typeof legacyWorkspaceSchema>;

export const LEGACY_WORKSPACE_KEYS = Object.keys(legacyWorkspaceSchema.shape) as (keyof z.infer<typeof legacyWorkspaceSchema>)[];

export type LegacyGlobal = {
  continueAttempts: number;
  mergeFate: MergeFate;
  preMerge: TaskVerificationStage;
  postMerge: TaskVerificationStage;
};
export type LegacyWorkspace = z.infer<typeof legacyWorkspaceSchema>;

export interface LegacySettings {
  global: LegacyGlobal;
  workspaces: ReadonlyMap<number, LegacyWorkspace>;
}

export interface LegacyExecution {
  continueAttempts: number;
  mergeFate: MergeFate;
  preMerge: TaskVerificationStage;
  postMerge: TaskVerificationStage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLegacyGlobal(rawGlobal: unknown): LegacyGlobal {
  const parsed = legacyGlobalSchema.parse(isRecord(rawGlobal) ? rawGlobal : {});
  const task = parsed.verify?.task;
  return {
    continueAttempts: parsed.drive?.continueAttempts ?? 10,
    mergeFate: parsed.drive?.mergeFate ?? 'auto-merge',
    preMerge: { commands: task?.preMerge?.commands ?? [], critics: task?.preMerge?.critics ?? [] },
    postMerge: { commands: task?.postMerge?.commands ?? [], critics: task?.postMerge?.critics ?? [] },
  };
}

export function parseLegacyWorkspace(rawEntry: unknown): LegacyWorkspace {
  return legacyWorkspaceSchema.parse(isRecord(rawEntry) ? rawEntry : {});
}

export interface LegacyGlobalRaw {
  drive?: Record<string, unknown>;
  verify?: { task: unknown };
}

export function pickLegacyGlobal(global: unknown): LegacyGlobalRaw {
  if (!isRecord(global)) return {};
  const out: LegacyGlobalRaw = {};
  if (isRecord(global.drive)) {
    const drive: Record<string, unknown> = {};
    for (const key of ['mergeFate', 'continueAttempts']) if (key in global.drive) drive[key] = global.drive[key];
    if (Object.keys(drive).length > 0) out.drive = drive;
  }
  if (isRecord(global.verify) && 'task' in global.verify) out.verify = { task: global.verify.task };
  return out;
}

export function withLegacyGlobal(patch: unknown, legacy: LegacyGlobalRaw): Record<string, unknown> {
  const base = isRecord(patch) ? patch : {};
  const out: Record<string, unknown> = { ...base };
  if (legacy.drive) out.drive = { ...(isRecord(base.drive) ? base.drive : {}), ...legacy.drive };
  if (legacy.verify) out.verify = { ...(isRecord(base.verify) ? base.verify : {}), ...legacy.verify };
  return out;
}

export function pickLegacyWorkspace(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {};
  const out: Record<string, unknown> = {};
  for (const key of LEGACY_WORKSPACE_KEYS) if (key in entry) out[key] = entry[key];
  return out;
}

function resolveStage(
  commandsOverlay: LegacyWorkspace['taskPreMergeCommands'],
  criticsOverlay: LegacyWorkspace['taskPreMergeCritics'],
  global: TaskVerificationStage,
): TaskVerificationStage {
  return {
    commands: mergeOverlay<VerificationCommand, NonNullable<LegacyWorkspace['taskPreMergeCommands']>[number]>(
      commandsOverlay ?? null, global.commands, (item) => item.id, (entry) => entry.ref, (entry) => entry.command,
    ),
    critics: mergeOverlay<TaskVerificationCritic, NonNullable<LegacyWorkspace['taskPreMergeCritics']>[number]>(
      criticsOverlay ?? null, global.critics, (item) => item.id, (entry) => entry.ref, (entry) => entry.critic,
    ),
  };
}

export function resolveLegacyExecution(global: LegacyGlobal, workspace: LegacyWorkspace | null): LegacyExecution {
  const own = workspace ?? {};
  return {
    continueAttempts: own.driveContinueAttempts ?? global.continueAttempts,
    mergeFate: own.driveMergeFate ?? global.mergeFate,
    preMerge: resolveStage(own.taskPreMergeCommands, own.taskPreMergeCritics, global.preMerge),
    postMerge: resolveStage(own.taskPostMergeCommands, own.taskPostMergeCritics, global.postMerge),
  };
}
