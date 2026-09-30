import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ExecutionContext } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { resolveExportSettings } from '../../archive/export-settings.js';
import { testExportDestination } from '../../archive/test-destination.js';
import { errorResponse } from '../schemas.js';

const bodySchema = z.object({
  workspaceId: z.union([z.string(), z.number()]).nullish().meta({ example: '1', description: 'Workspace whose overrides apply; omit or null for the global config only.' }),
  destination: z.enum(['directory', 's3']).meta({ example: 's3' }),
});

const resultSchema = z.object({
  destination: z.enum(['directory', 's3']).meta({ example: 's3' }),
  ok: z.boolean().meta({ example: true }),
  error: z.string().optional().meta({ example: 'NoSuchBucket: The specified bucket does not exist' }),
  testedAt: z.string().meta({ example: '2026-09-30T12:00:00.000Z' }),
});

export async function exportRoutes(fastify: FastifyInstance, ctx: Pick<ExecutionContext, 'settingsStore' | 'workspaces'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/export/test-destination',
    {
      schema: {
        tags: ['Export'],
        description: 'Write then remove a probe file or object at an Export Destination. A destination failure is reported as ok:false, never a 5xx.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: bodySchema,
        response: {
          200: resultSchema.describe('The probe outcome.'),
          400: errorResponse('The destination is not configured, or the workspaceId is malformed.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      const { workspaceId, destination } = req.body;
      let workspace;
      if (workspaceId !== null && workspaceId !== undefined) {
        const id = Number(workspaceId);
        if (!Number.isInteger(id)) throw new DomainError('validation', 'workspaceId must be a Workspace id');
        workspace = await ctx.workspaces.get(id);
      }
      const settings = resolveExportSettings(ctx.settingsStore.getGlobal(), workspace);
      if (destination === 'directory' && settings.directoryPath === null) throw new DomainError('validation', 'no export directory path is configured');
      if (destination === 's3' && settings.s3 === null) throw new DomainError('validation', 'no S3 bucket is configured');
      return testExportDestination(settings, destination);
    },
  );
}
