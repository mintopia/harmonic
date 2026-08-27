import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import {
  HARNESS_IDS,
  ISOLATION_MODES,
  MERGE_FATES,
  PRIORITIES,
  appConfigSchema,
  verificationCommandSchema,
  verificationCriticSchema,
  verificationReviewSchema,
  type AppConfig,
  type LegacyConfig,
} from '../../config.js';

/**
 * A deep-partial patch of `AppConfig` (config.ts). Every field is optional
 * at every level so an operator can send just the branch they're changing;
 * `ConfigStore.update` deep-merges it onto the stored config and re-parses
 * the result through `appConfigSchema`, which is the actual source of
 * truth for validity — this schema exists for documentation and to reject
 * non-object junk, not to duplicate that validation.
 */
const configPatchBodySchema = z
  .object({
    /** Operator display name for this instance; feeds the sidebar heading and browser title. */
    name: z.string().meta({ example: 'Production' }),
    harnesses: z
      // partialRecord, not record: a record keyed by an enum requires every
      // enum key present (zod v4), but a config patch may touch only one
      // harness.
      .partialRecord(
        z.enum(HARNESS_IDS),
        z.object({
          /** Command + args spawned to speak ACP on stdio. */
          command: z.string().meta({ example: 'npx' }),
          args: z.array(z.string()).meta({ example: ['--yes', '@agentclientprotocol/claude-agent-acp'] }),
          /** Extra environment for the spawned process; deep-merged, so vars absent here are left alone. */
          env: z.record(z.string(), z.string()).meta({ example: { NODE_OPTIONS: '--max-old-space-size=4096' } }),
          models: z.array(z.string()).meta({ example: ['sonnet-5', 'opus-4-8'] }),
          /** Must be one of `models` when any are listed — enforced by the config schema on write. */
          defaultModel: z.string().meta({ example: 'sonnet-5' }),
          /** Root of the harness's native session logs; empty string disables the usage fallback. */
          sessionLogDir: z.string().meta({ example: '/home/dev/.claude/projects' }),
        }).partial(),
      )
      // A record declares no shape, so the docs print its JSON Schema unless
      // the record itself carries an example — the inner fields' examples
      // never surface on their own.
      .meta({ example: { claude: { defaultModel: 'sonnet-5' } } })
      .optional(),
    prices: z
      .record(
        z.string(),
        z.object({
          input: z.number().nonnegative().meta({ example: 3 }),
          output: z.number().nonnegative().meta({ example: 15 }),
          cacheRead: z.number().nonnegative().meta({ example: 0.3 }),
          cacheWrite: z.number().nonnegative().meta({ example: 3.75 }),
        }).partial(),
      )
      .meta({ example: { 'sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } })
      .optional(),
    defaults: z
      .object({
        harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
        workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
        isolationMode: z.enum(ISOLATION_MODES).meta({ example: 'worktree' }),
        priority: z.enum(PRIORITIES).meta({ example: 'normal' }),
        integrationRetries: z.number().int().min(1).meta({ example: 5 }),
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
        maxConcurrentRuns: z.number().int().min(1).meta({ example: 2 }),
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
      })
      .partial()
      .optional(),
    agentReview: z
      .boolean()
      .optional()
      .meta({ example: false })
      .describe(
        'Deprecated (#140): folded into verification.autoAccept; retained so a pre-upgrade client PATCHing it still lands non-exposing behaviour.',
      ),
    /** Migration-only input for clients saved before #312. It is converted to
     * `verify` before storage and never appears in the response. */
    verification: z
      .object({
        /** The command verifier; null clears it. Send the whole object to set one (deep-merged, then re-parsed). */
        command: verificationCommandSchema.nullable().meta({ example: { command: 'npm', args: ['test'] } }),
        /** The agent critic; null clears it. Send the whole object to set one. */
        critic: verificationCriticSchema.nullable().meta({ example: { prompt: 'Review the diff for correctness.', model: 'claude-opus-5' } }),
        /** Accepted and dropped: auto-accept described the review gate ADR-0041 removed. */
        autoAccept: z.boolean().meta({ example: true }),
      })
      .partial()
      .meta({ example: { critic: null } })
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

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description: 'Get the full effective configuration. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: {
          200: appConfigSchema.describe(
            'The stored configuration in full: harnesses, price overrides, defaults, auto-runner settings, and flags.',
          ),
        },
      },
    },
    async () => ctx.configStore.get(),
  );

  app.patch(
    '/config',
    {
      schema: {
        tags: ['Config'],
        description:
          'Deep-merge a partial config patch onto the stored configuration. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: configPatchBodySchema,
        response: {
          200: appConfigSchema.describe('The whole configuration as stored once the patch was merged onto it.'),
        },
      },
    },
    async (req) => {
      const updated = await ctx.configStore.update(req.body as LegacyConfig);
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
          "Full-replace the stored configuration. Unlike PATCH's deep-merge, a record key omitted here (a harness env var, a price override) is deleted, not left alone — the settings UI loads the whole config, edits locally, and saves the complete object so it can delete as well as add. Validated atomically against the config schema: an invalid body is rejected with no partial write. Operator only; not reachable with a run-scoped Run Key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: appConfigSchema,
        response: {
          200: appConfigSchema.describe(
            "The whole configuration as stored after the replace, with omitted optional fields filled from the schema's defaults.",
          ),
        },
      },
    },
    async (req) => {
      const updated = await ctx.configStore.replace(req.body as AppConfig);
      ctx.autoRunner.poke();
      return updated;
    },
  );
}
