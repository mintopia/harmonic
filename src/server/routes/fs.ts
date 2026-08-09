import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { browseDirectory, fsListingSchema } from '../../domain/fs-browse.js';
import { errorResponse } from '../schemas.js';

const fsQuerySchema = z.object({
  path: z
    .string()
    .optional()
    .meta({ example: '/home/dev', description: 'Absolute path to browse; defaults to the server user home.' }),
});

export async function fsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/fs',
    {
      schema: {
        tags: ['Filesystem'],
        description:
          'Immediate child directories of `path`, one level deep — the data behind the workspace directory ' +
          "picker (issue #62). An empty or omitted `path` starts at the server user's home. Files and hidden " +
          '(dot) directories are excluded; entries are sorted by name. No root restriction — any directory the ' +
          'running user can read is browsable (a sysadmin concern, per the map decision). Operator-only: a ' +
          'full-scope session is required (not reachable with a scoped or read key).',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: fsQuerySchema,
        response: {
          200: fsListingSchema.describe('The browsed path, its parent, and its immediate child directories.'),
          400: errorResponse('The path is not a directory, or the running user cannot read it.'),
          404: errorResponse('No such path.'),
        },
      },
    },
    async (req) => browseDirectory(req.query.path),
  );
}
