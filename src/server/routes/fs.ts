import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { browseDirectory, fsListingSchema } from '../../domain/fs-browse.js';
import { listWorkspaceFiles, readWorkspaceFile, workspaceFileListingSchema, workspaceFileSchema } from '../../domain/workspace-files.js';
import type { TrackingContext } from '../app.js';
import { errorResponse } from '../schemas.js';

const fsQuerySchema = z.object({
  path: z
    .string()
    .optional()
    .meta({ example: '/home/dev', description: 'Absolute path to browse; defaults to the server user home.' }),
});

const workspaceQuerySchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
  path: z.string().default(''),
});

const workspaceTreeQuerySchema = workspaceQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export async function fsRoutes(fastify: FastifyInstance, ctx: Pick<TrackingContext, 'workspaces'>): Promise<void> {
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

  app.get('/fs/tree', {
    schema: {
      tags: ['Filesystem'],
      description: 'A paginated directory listing confined to one Workspace working directory.',
      querystring: workspaceTreeQuerySchema,
      response: { 200: workspaceFileListingSchema.describe('A page of workspace files and directories.'), 400: errorResponse('Invalid path.'), 404: errorResponse('Workspace or path not found.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.query.workspaceId);
    const { path, limit, offset } = req.query;
    return listWorkspaceFiles({
      root: workspace.workingDir,
      excludedDirectories: workspace.excludedDirectories,
      path,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    });
  });

  app.get('/fs/file', {
    schema: {
      tags: ['Filesystem'],
      description: 'Read one text file confined to a Workspace working directory.',
      querystring: workspaceQuerySchema,
      response: { 200: workspaceFileSchema.describe('The requested workspace file and its metadata.'), 400: errorResponse('Invalid path.'), 404: errorResponse('Workspace or path not found.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.query.workspaceId);
    return readWorkspaceFile({ root: workspace.workingDir, path: req.query.path });
  });
}
