import { trackerRef, type TrackerRef } from '../../tracker/adapter.js';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import type { TaskRow } from '../../db/schema.js';
import type { ExportDownload } from '../../archive/task-export.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse, idParamsSchema, taskExportAgainResponseSchema, taskExportStatusSchema } from '../schemas.js';

function isFinished(task: TaskRow): boolean {
  return task.state === 'done' || task.state === 'cancelled';
}

async function finishedTask(ctx: AppContext, id: number): Promise<{ task: TaskRow; forcePartial: boolean }> {
  const task = await ctx.tasks.get(id);
  if (!isFinished(task)) throw new DomainError('invalid_state', `Task ${id} is ${task.state}; only a finished Task can be exported`);
  const forcePartial = task.archiveId === null;
  if (!forcePartial) return { task, forcePartial };
  await ctx.archive.ensure(task);
  return { task: await ctx.tasks.get(id), forcePartial };
}

const epicExportParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
  epicRef: z.string().min(1).meta({ example: '42' }),
});

async function sendDownload(reply: FastifyReply, built: ExportDownload): Promise<FastifyReply> {
  if (reply.raw.destroyed) {
    await rm(built.path, { force: true });
    return reply;
  }
  const stream = createReadStream(built.path);
  stream.once('close', () => void rm(built.path, { force: true }));
  reply.raw.once('close', () => stream.destroy());
  return reply
    .header('content-type', 'application/gzip')
    .header('content-length', built.bytes)
    .header('content-disposition', `attachment; filename="${built.name}"`)
    .send(stream);
}

async function integratedEpic(ctx: AppContext, workspaceId: number, epicRef: TrackerRef): Promise<void> {
  await ctx.workspaces.assertExists(workspaceId);
  const stored = (await ctx.tasks.listStoredEpics(workspaceId)).find((e) => e.trackerRef === epicRef);
  if (!stored) throw new DomainError('not_found', `no Epic ${epicRef} stored for workspace ${workspaceId}`);
  if (stored.state !== 'integrated') throw new DomainError('invalid_state', `Epic ${epicRef} is ${stored.state}; only an integrated Epic can be exported`);
}

export async function taskExportRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/tasks/:id/export',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Export status for a Task: the latest Export (filename, build time, size, redactions, partial flag) with per-Destination ' +
          'delivery status, last attempt, error and pending retry, plus earlier Exports. `latest` is null until an Export has been attempted.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: { 200: taskExportStatusSchema.describe('Latest and earlier Exports with per-Destination status.'), 404: errorResponse('No task has that id.') },
      },
    },
    async (req) => {
      const task = await ctx.tasks.get(req.params.id);
      return { exportable: isFinished(task), ...(await ctx.exporter.status(task)) };
    },
  );

  app.post(
    '/tasks/:id/export',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Export again: rebuild the Export and deliver it to every configured Destination regardless of the includeStates filter, ' +
          'as a new Export that never overwrites an earlier one. A Task that predates the Archive is built from surviving records ' +
          'and flagged `partial`. Only done or cancelled Tasks; 409 when the Task is not finished or no Destination is enabled.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: taskExportAgainResponseSchema.describe('Per-Destination outcomes of the new Export, plus the refreshed status.'),
          404: errorResponse('No task has that id.'),
          409: errorResponse('The Task is not finished, or no Export Destination is enabled.'),
        },
      },
    },
    async (req) => {
      const { task, forcePartial } = await finishedTask(ctx, req.params.id);
      const outcomes = await ctx.exporter.exportAgain(task, { forcePartial });
      if (outcomes === null) throw new DomainError('conflict', 'No Export Destination is enabled for this Task');
      return {
        outcomes: outcomes.map((o) => ({ destination: o.destination, status: o.status, file: o.file, error: o.status === 'failed' ? o.error : null })),
        export: { exportable: true, ...(await ctx.exporter.status(task)) },
      };
    },
  );

  app.get(
    '/tasks/:id/export/download',
    {
      schema: {
        tags: ['Tasks'],
        description:
          'Stream a freshly built, redacted Export tarball (tar.gz) to the browser. Needs no configured Destination and is not recorded as an Export.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: z.any().describe('The tar.gz bytes, as an attachment named after the canonical Export filename.'),
          404: errorResponse('No task has that id.'),
          409: errorResponse('The Task is not finished.'),
        },
      },
    },
    async (req, reply) => {
      const { task, forcePartial } = await finishedTask(ctx, req.params.id);
      await sendDownload(reply, await ctx.exporter.buildDownload(task, { forcePartial }));
    },
  );

  app.get(
    '/workspaces/:workspaceId/epics/:epicRef/export',
    {
      schema: {
        tags: ['Epics'],
        description:
          'Export status for an Epic: the latest Export with per-Destination delivery status, last attempt, error and pending retry, plus earlier Exports. ' +
          '`exportable` is true once the Epic is integrated; `latest` is null until an Export has been attempted.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicExportParamsSchema,
        response: { 200: taskExportStatusSchema.describe('Latest and earlier Epic Exports with per-Destination status.'), 404: errorResponse('No Workspace has that id.') },
      },
    },
    async (req) => {
      const workspaceId = req.params.workspaceId;
      const epicRef = trackerRef(req.params.epicRef);
      await ctx.workspaces.assertExists(workspaceId);
      const stored = (await ctx.tasks.listStoredEpics(workspaceId)).find((e) => e.trackerRef === epicRef);
      return { exportable: stored?.state === 'integrated', ...(await ctx.exporter.epicStatus(workspaceId, epicRef)) };
    },
  );

  app.post(
    '/workspaces/:workspaceId/epics/:epicRef/export',
    {
      schema: {
        tags: ['Epics'],
        description:
          'Export again: rebuild the Epic Export and deliver it to every configured Destination regardless of the includeStates filter, ' +
          'as a new Export that never overwrites an earlier one. Only integrated Epics; 409 when the Epic is not integrated or no Destination is enabled.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicExportParamsSchema,
        response: {
          200: taskExportAgainResponseSchema.describe('Per-Destination outcomes of the new Export, plus the refreshed status.'),
          404: errorResponse('No Workspace or stored Epic has that id.'),
          409: errorResponse('The Epic is not integrated, or no Export Destination is enabled.'),
        },
      },
    },
    async (req) => {
      const workspaceId = req.params.workspaceId;
      const epicRef = trackerRef(req.params.epicRef);
      await integratedEpic(ctx, workspaceId, epicRef);
      const outcomes = await ctx.exporter.exportEpicAgain(workspaceId, epicRef);
      if (outcomes === null) throw new DomainError('conflict', 'No Export Destination is enabled for this Epic');
      return {
        outcomes: outcomes.map((o) => ({ destination: o.destination, status: o.status, file: o.file, error: o.status === 'failed' ? o.error : null })),
        export: { exportable: true, ...(await ctx.exporter.epicStatus(workspaceId, epicRef)) },
      };
    },
  );

  app.get(
    '/workspaces/:workspaceId/epics/:epicRef/export/download',
    {
      schema: {
        tags: ['Epics'],
        description: 'Stream a freshly built, redacted Epic Export tarball (tar.gz). Needs no configured Destination and is not recorded as an Export.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicExportParamsSchema,
        response: {
          200: z.any().describe('The tar.gz bytes, as an attachment named after the canonical Epic Export filename.'),
          404: errorResponse('No Workspace or stored Epic has that id.'),
          409: errorResponse('The Epic is not integrated.'),
        },
      },
    },
    async (req, reply) => {
      const workspaceId = req.params.workspaceId;
      const epicRef = trackerRef(req.params.epicRef);
      await integratedEpic(ctx, workspaceId, epicRef);
      await sendDownload(reply, await ctx.exporter.buildEpicDownload(workspaceId, epicRef));
    },
  );
}
