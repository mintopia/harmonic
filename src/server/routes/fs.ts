import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Git } from '../../execution/git.js';
import { browseDirectory, fsListingSchema } from '../../domain/fs-browse.js';
import { gitStatusSchema, readGitStatus } from '../../domain/git-status.js';
import { listWorkspaceFiles, readWorkspaceFile, streamWorkspaceFile, workspaceFileListingSchema, workspaceFileSchema, workspaceFileWriteSchema, writeWorkspaceFile } from '../../domain/workspace-files.js';
import { logger } from '../../logger.js';
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

const gitPathsBodySchema = z.object({
  workspaceId: z.number().int().positive(),
  paths: z.array(z.string().min(1).refine((path) => !path.startsWith('/') && !path.split('/').includes('..'))).min(1),
});

const gitCommitBodySchema = z.object({
  workspaceId: z.number().int().positive(),
  message: z.string().trim().min(1).max(10_000),
});

const gitMutationResponseSchema = z.object({ ok: z.literal(true) });
const gitMutationResponse = { ok: true } satisfies { ok: true };
const inlineMediaTypes = new Set([
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'image/gif', 'image/jpeg', 'image/png', 'image/webp',
]);

export async function fsRoutes(fastify: FastifyInstance, ctx: Pick<TrackingContext, 'workspaces' | 'settingsStore'>): Promise<void> {
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
    return readWorkspaceFile({ root: workspace.workingDir, path: req.query.path, maxBytes: ctx.settingsStore.getGlobal().editor.maxFileSizeBytes });
  });

  app.get<{ Querystring: z.infer<typeof workspaceQuerySchema> }>('/fs/raw', {
    schema: {
      tags: ['Filesystem'],
      description: 'Stream one file confined to a Workspace working directory.',
      querystring: workspaceQuerySchema,
      response: { 400: errorResponse('Invalid path.'), 404: errorResponse('Workspace or path not found.') },
    },
  }, async (req, reply) => {
    const workspace = await ctx.workspaces.get(req.query.workspaceId);
    const file = await streamWorkspaceFile({ root: workspace.workingDir, path: req.query.path });
    const inline = inlineMediaTypes.has(file.mime);
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', inline ? file.mime : 'application/octet-stream');
    reply.raw.setHeader('content-length', file.size);
    reply.raw.setHeader('content-disposition', inline ? 'inline' : 'attachment');
    file.stream.pipe(reply.raw);
  });

  app.put('/fs/file', {
    schema: {
      tags: ['Filesystem'],
      description: 'Operator-only: write one text file confined to a Workspace working directory.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      querystring: workspaceQuerySchema,
      body: workspaceFileWriteSchema,
      response: { 200: workspaceFileSchema.describe('The saved workspace file and its metadata.'), 400: errorResponse('Invalid path or body.'), 404: errorResponse('Workspace or path not found.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.query.workspaceId);
    const file = await writeWorkspaceFile({ root: workspace.workingDir, path: req.query.path, text: req.body.text });
    logger.info('workspace file written', { workspaceId: workspace.id, path: req.query.path });
    return file;
  });

  app.get('/git/status', {
    schema: {
      tags: ['Filesystem'],
      description: 'Read the Workspace Git status without changing its working directory or index.',
      querystring: z.object({ workspaceId: z.coerce.number().int().positive() }),
      response: { 200: gitStatusSchema.describe('Git status entries from porcelain v2 output.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.query.workspaceId);
    return readGitStatus(workspace.workingDir);
  });

  app.post('/git/stage', {
    schema: {
      tags: ['Filesystem'],
      description: 'Stage selected paths in a Workspace Git repository.',
      body: gitPathsBodySchema,
      response: { 200: gitMutationResponseSchema.describe('The selected paths are staged.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.body.workspaceId);
    await Git.stage(workspace.workingDir, req.body.paths);
    return gitMutationResponse;
  });

  app.post('/git/unstage', {
    schema: {
      tags: ['Filesystem'],
      description: 'Unstage selected paths in a Workspace Git repository.',
      body: gitPathsBodySchema,
      response: { 200: gitMutationResponseSchema.describe('The selected paths are unstaged.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.body.workspaceId);
    await Git.unstage(workspace.workingDir, req.body.paths);
    return gitMutationResponse;
  });

  app.post('/git/discard', {
    schema: {
      tags: ['Filesystem'],
      description: 'Discard selected tracked or untracked paths in a Workspace Git repository.',
      body: gitPathsBodySchema,
      response: { 200: gitMutationResponseSchema.describe('The selected changes are discarded.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.body.workspaceId);
    await Git.discard(workspace.workingDir, req.body.paths);
    return gitMutationResponse;
  });

  app.post('/git/commit', {
    schema: {
      tags: ['Filesystem'],
      description: 'Commit the staged changes in a Workspace Git repository.',
      body: gitCommitBodySchema,
      response: { 200: gitMutationResponseSchema.describe('The staged changes are committed.') },
    },
  }, async (req) => {
    const workspace = await ctx.workspaces.get(req.body.workspaceId);
    await Git.commit(workspace.workingDir, req.body.message);
    return gitMutationResponse;
  });
}
