import type { FastifyInstance } from 'fastify';
import { changedPromptCodes, namedPromptCodes, syncEditedPrompts, withLibraryPrompts } from '../../domain/prompt-library-sources.js';
import type { PromptLibrary } from '../../domain/prompt-library-store.js';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ExecutionContext } from '../app.js';
import { adapterFor } from '../../execution/harness/registry.js';
import {
  HARNESS_IDS,
  ISOLATION_MODES,
  PRIORITIES,
  appConfigSchema,
  modelCatalogEntrySchema,
  epicVerificationStageSchema,
  type AppConfig,
  type DeepPartial,
  promptFragmentsShape,
  routingLabelSchema,
  workflowLabelSchema,
  modelOptionsSchema,
} from '../../config.js';
import { workflowReferenceProblems } from '../../domain/workflow-labels.js';
import type { WorkflowLibrary } from '../../domain/workflow-library-store.js';
import { DomainError } from '../../domain/errors.js';
import { maskConfigSecrets } from '../../archive/export-secrets.js';

const harnessPermissionModesSchema = z.record(
  z.string(),
  z.object({ modes: z.record(z.string(), z.string()), defaultMode: z.string() }),
);

/** Rejects workflow names the library lacks; names the stored config already references are tolerated so a stale one cannot block unrelated saves. */
function assertWorkflowRefs(ctx: Pick<ExecutionContext, 'settingsStore'> & { workflows: WorkflowLibrary }, workflow: string | null | undefined, labels: readonly { label: string; workflow: string }[] | undefined): void {
  const stored = ctx.settingsStore.getGlobal();
  const known = new Set([stored.defaults.workflow, ...stored.workflowLabels.map((l) => l.workflow)]);
  const problems = workflowReferenceProblems(ctx.workflows, {
    workflow: workflow != null && !known.has(workflow) ? workflow : null,
    labels: (labels ?? []).filter((l) => !known.has(l.workflow)),
  });
  if (problems[0]) throw new DomainError('validation', problems[0]);
}

function harnessPermissionModes() {
  return Object.fromEntries(
    HARNESS_IDS.flatMap((id) => {
      const adapter = adapterFor(id);
      if (!adapter.permissionModes || !adapter.defaultPermissionMode) return [];
      return [[id, { modes: { ...adapter.permissionModes }, defaultMode: adapter.defaultPermissionMode }]];
    }),
  );
}

const exportShape = appConfigSchema.shape.export.shape;

/** A deep-partial patch of `AppConfig`; `appConfigSchema` re-validates the merged result. */
const configPatchBodySchema = z
  .object({
    /** Operator display name for this instance; feeds the sidebar heading and browser title. */
    name: z.string().meta({ example: 'Production' }),
    harnesses: z
      // zod v4: a record keyed by an enum requires every key; partialRecord lets a patch touch one harness.
      .partialRecord(
        z.enum(HARNESS_IDS),
        z.object({
          /** Command + args spawned to speak ACP on stdio. */
          command: z.string().meta({ example: 'npx' }),
          args: z.array(z.string()).meta({ example: ['--yes', '@agentclientprotocol/claude-agent-acp'] }),
          /** Extra environment for the spawned process; deep-merged, so vars absent here are left alone. */
          env: z.record(z.string(), z.string()).meta({ example: { NODE_OPTIONS: '--max-old-space-size=4096' } }),
          models: z.union([
            z.array(modelCatalogEntrySchema),
            z.record(z.string(), z.union([
              modelCatalogEntrySchema.partial(),
              z.null(),
            ])),
          ]).meta({ example: { 'sonnet-5': { contextWindow: 200000 }, 'retired-model': null } }),
          /** Must be one of `models` when any are listed — enforced by the config schema on write. */
          defaultModel: z.string().meta({ example: 'sonnet-5' }),
          cacheWarmSeconds: z.number().int().positive().meta({ example: 300 }),
          /** Unattended ACP permission mode; omit to use the adapter default. */
          permissionMode: z.string().meta({ example: 'bypassPermissions' }),
          /** Root of the harness's native session logs; empty string disables the usage fallback. */
          sessionLogDir: z.string().meta({ example: '/home/dev/.claude/projects' }),
        }).partial(),
      )
      .meta({ example: { claude: { defaultModel: 'sonnet-5' } } })
      .optional(),
    defaults: z
      .object({
        harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
        workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
        isolationMode: z.enum(ISOLATION_MODES).meta({ example: 'worktree' }),
        priority: z.enum(PRIORITIES).meta({ example: 'normal' }),
        conflictResolveTurns: z.number().int().min(0).meta({ example: 2 }),
        workflow: z.string().min(1).nullable().meta({ example: 'implement' }),
      })
      .partial()
      .optional(),
    /** Replaces the whole ordered list; labels are unique case-insensitively and each Harness must be configured. */
    routingLabels: z.array(routingLabelSchema).meta({ example: [{ label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' }] }).optional(),
    workflowLabels: z.array(workflowLabelSchema).meta({ example: [{ label: 'bug', workflow: 'implement' }] }).optional(),
    /** Replaces the whole ordered list; ids are unique, each Harness must be configured and each Model in that Harness's catalog. */
    modelOptions: modelOptionsSchema.optional(),
    chat: z
      .object({
        /** Default Harness a new Conversation starts with. */
        harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
        /** Default model a new Conversation starts with; must be one of that harness's models (enforced on write). */
        model: z.string().meta({ example: 'claude-sonnet-5' }),
      })
      .partial()
      .optional(),
    autoRunner: z
      .object({
        enabled: z.boolean().meta({ example: true }),
        maxConcurrentAttempts: z.number().int().min(1).meta({ example: 2 }),
      })
      .partial()
      .optional(),
    agentMessages: z
      .object({
        enabled: z.boolean().meta({ example: false }),
        sendCap: z.number().int().min(1).meta({ example: 10 }),
      })
      .partial()
      .optional(),
    /** Maximum implementation attempts before a ticket is escalated. */
    maxAttempts: z.number().int().min(1).meta({ example: 2 }),
    contextReuseTokenLimit: z.number().int().min(0).meta({ example: 200_000 }),
    drive: z
      .object({
        prompt: z.string().meta({ example: '{skill} {ref}\n\nResolve #{ref} ({url}) end to end — read the issue yourself.' }),
        unattendedReminder: z.string().meta({ example: '## Running unattended\n\nYou are Harmonic Task {taskId}…' }),
        continuePrompt: z.string().meta({ example: "Your last turn ended but Task {taskId} isn't finished…" }),
        commitNudge: z.string().min(1).meta({ example: 'Commit the completed work now, then finish.' }),
      })
      .partial()
      .optional(),
    promptFragments: z.object(promptFragmentsShape).partial().optional(),
    merge: appConfigSchema.shape.merge.partial().optional(),
    verify: z
      .object({
        epic: z.object({ preMerge: epicVerificationStageSchema, resolvePrompt: z.string().min(1), resolveSuffix: appConfigSchema.shape.verify.shape.epic.shape.resolveSuffix }).partial(),
      })
      .partial()
      .optional(),
    archive: z.object({ retain: appConfigSchema.shape.archive.shape.retain.partial() }).partial().optional(),
    export: z
      .object({
        enabled: exportShape.enabled,
        includeStates: exportShape.includeStates,
        directory: exportShape.directory.partial(),
        s3: exportShape.s3.partial(),
        redact: exportShape.redact,
      })
      .partial()
      .optional(),
  })
  .partial()
  .meta({ id: 'ConfigPatch' });

export async function configRoutes(fastify: FastifyInstance, ctx: Pick<ExecutionContext, 'autoRunner' | 'settingsStore'> & { prompts: PromptLibrary; workflows: WorkflowLibrary }): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description: 'Get the full effective configuration.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: {
          200: appConfigSchema.describe(
            'The stored configuration in full: harnesses and their model catalogs, defaults, auto-runner settings, and flags.',
          ),
        },
      },
    },
    async () => maskConfigSecrets(withLibraryPrompts(ctx.settingsStore.getGlobal(), ctx.prompts)),
  );

  app.get(
    '/config/layers',
    {
      schema: {
        tags: ['Config'],
        description: 'Get the distributed baseline and effective global configuration for settings inheritance controls.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: z.object({ baseline: appConfigSchema, global: appConfigSchema, harnessPermissionModes: harnessPermissionModesSchema }).describe('The distributed baseline, effective global config, and adapter-declared Harness permission modes for settings controls.') },
      },
    },
    async () => ({ baseline: ctx.settingsStore.getBaseline(), global: maskConfigSecrets(withLibraryPrompts(ctx.settingsStore.getGlobal(), ctx.prompts)), harnessPermissionModes: harnessPermissionModes() }),
  );

  app.patch(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description:
          'Deep-merge a partial config patch onto the stored configuration.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: configPatchBodySchema,
        response: {
          200: appConfigSchema.describe('The whole configuration as stored once the patch was merged onto it.'),
        },
      },
    },
    async (req) => {
      assertWorkflowRefs(ctx, req.body.defaults?.workflow, req.body.workflowLabels);
      const updated = await ctx.settingsStore.updateGlobal(req.body as DeepPartial<AppConfig>);
      await syncEditedPrompts(ctx.prompts, updated, namedPromptCodes(req.body));
      ctx.autoRunner.poke();
      return maskConfigSecrets(withLibraryPrompts(updated, ctx.prompts));
    },
  );

  app.put(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description:
          "Full-replace the stored configuration. Unlike PATCH's deep-merge, a record key omitted here (a harness environment variable, a catalog entry) is deleted, not left alone. The settings UI loads the whole config, edits locally, and saves the complete object so it can delete as well as add. The config schema validates the request atomically, so an invalid body makes no partial write.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: appConfigSchema,
        response: {
          200: appConfigSchema.describe(
            'The whole configuration as stored after the replace.',
          ),
        },
      },
    },
    async (req) => {
      const before = withLibraryPrompts(ctx.settingsStore.getGlobal(), ctx.prompts);
      assertWorkflowRefs(ctx, req.body.defaults.workflow, req.body.workflowLabels);
      const updated = await ctx.settingsStore.replaceGlobal(req.body as AppConfig);
      await syncEditedPrompts(ctx.prompts, updated, changedPromptCodes(before, updated));
      ctx.autoRunner.poke();
      return maskConfigSecrets(withLibraryPrompts(updated, ctx.prompts));
    },
  );

  app.delete(
    '/config/overrides',
    {
      schema: {
        tags: ['Config'],
        description: 'Clear every global override and return to the distributed baseline.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: appConfigSchema.describe('The whole configuration as stored once every global override was cleared.') },
      },
    },
    async () => {
      const updated = await ctx.settingsStore.revertGlobal();
      await syncEditedPrompts(ctx.prompts, updated);
      ctx.autoRunner.poke();
      return maskConfigSecrets(withLibraryPrompts(updated, ctx.prompts));
    },
  );
}
