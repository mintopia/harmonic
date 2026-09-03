import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ExecutionContext } from '../app.js';
import {
  HARNESS_IDS,
  ISOLATION_MODES,
  MERGE_FATES,
  PRIORITIES,
  appConfigSchema,
  modelCatalogEntrySchema,
  verificationCommandSchema,
  verificationReviewSchema,
  type AppConfig,
  type DeepPartial,
} from '../../config.js';

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
      })
      .partial()
      .optional(),
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
    /** Maximum implementation attempts before a ticket is escalated. */
    maxAttempts: z.number().int().min(1).meta({ example: 2 }),
    contextReuseTokenLimit: z.number().int().min(0).meta({ example: 200_000 }),
    drive: z
      .object({
        prompt: z.string().meta({ example: '{skill}\n\nResolve #{ref} ({url}) end to end — read the issue yourself.' }),
        unattendedReminder: z.string().meta({ example: '## Running unattended\n\nYou are Harmonic Task {taskId}…' }),
        continuePrompt: z.string().meta({ example: "Your last turn ended but Task {taskId} isn't finished…" }),
        mergeFate: z.enum(MERGE_FATES).meta({ example: 'auto-merge' }),
        continueAttempts: z.number().int().min(0).meta({ example: 1 }),
      })
      .partial()
      .optional(),
    verify: z
      .object({
        commands: z.array(verificationCommandSchema),
        review: verificationReviewSchema,
      })
      .partial()
      .optional(),
  })
  .partial()
  .meta({ id: 'ConfigPatch' });

export async function configRoutes(fastify: FastifyInstance, ctx: Pick<ExecutionContext, 'autoRunner' | 'settingsStore'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description: 'Get the full effective configuration. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: {
          200: appConfigSchema.describe(
            'The stored configuration in full: harnesses and their model catalogs, defaults, auto-runner settings, and flags.',
          ),
        },
      },
    },
    async () => ctx.settingsStore.getGlobal(),
  );

  app.get(
    '/config/layers',
    {
      schema: {
        tags: ['Config'],
        description: 'Get the distributed baseline and effective global configuration for settings inheritance controls.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: z.object({ baseline: appConfigSchema, global: appConfigSchema }).describe('The distributed baseline config and the effective global config the inheritance controls resolve against.') },
      },
    },
    async () => ({ baseline: ctx.settingsStore.getBaseline(), global: ctx.settingsStore.getGlobal() }),
  );

  app.patch(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description:
          'Deep-merge a partial config patch onto the stored configuration. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: configPatchBodySchema,
        response: {
          200: appConfigSchema.describe('The whole configuration as stored once the patch was merged onto it.'),
        },
      },
    },
    async (req) => {
      const updated = await ctx.settingsStore.updateGlobal(req.body as DeepPartial<AppConfig>);
      ctx.autoRunner.poke();
      return updated;
    },
  );

  app.put(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description:
          "Full-replace the stored configuration. Unlike PATCH's deep-merge, a record key omitted here (a harness environment variable, a catalog entry) is deleted, not left alone. The settings UI loads the whole config, edits locally, and saves the complete object so it can delete as well as add. The config schema validates the request atomically, so an invalid body makes no partial write. Operator only; not reachable with an attempt-scoped Attempt Key.",
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
      const updated = await ctx.settingsStore.replaceGlobal(req.body as AppConfig);
      ctx.autoRunner.poke();
      return updated;
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
      ctx.autoRunner.poke();
      return updated;
    },
  );
}
