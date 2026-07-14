import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES, appConfigSchema, type DeepPartial, type AppConfig } from '../../config.js';

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
    harnesses: z
      // partialRecord, not record: a record keyed by an enum requires every
      // enum key present (zod v4), but a config patch may touch only one
      // harness.
      .partialRecord(
        z.enum(HARNESS_IDS),
        z.object({
          command: z.string(),
          args: z.array(z.string()),
          env: z.record(z.string(), z.string()),
          models: z.array(z.string()),
          defaultModel: z.string(),
          sessionLogDir: z.string(),
        }).partial(),
      )
      .optional(),
    prices: z
      .record(
        z.string(),
        z.object({
          input: z.number().nonnegative(),
          output: z.number().nonnegative(),
          cacheRead: z.number().nonnegative(),
          cacheWrite: z.number().nonnegative(),
        }).partial(),
      )
      .optional(),
    defaults: z
      .object({
        harness: z.enum(HARNESS_IDS),
        workingDir: z.string(),
        isolationMode: z.enum(ISOLATION_MODES),
        priority: z.enum(PRIORITIES),
      })
      .partial()
      .optional(),
    autoRunner: z
      .object({
        enabled: z.boolean(),
        maxConcurrentRuns: z.number().int().min(1),
      })
      .partial()
      .optional(),
    agentReview: z.boolean().optional(),
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
        response: { 200: appConfigSchema },
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
        response: { 200: appConfigSchema },
      },
    },
    async (req) => {
      // The declared body schema is deliberately permissive (see above);
      // `ConfigStore.update`'s own re-parse through `appConfigSchema` is
      // the actual validation boundary, same as before this migration.
      const updated = ctx.configStore.update(req.body as DeepPartial<AppConfig>);
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
        response: { 200: appConfigSchema },
      },
    },
    async (req) => {
      const updated = ctx.configStore.replace(req.body as AppConfig);
      ctx.autoRunner.poke();
      return updated;
    },
  );
}
