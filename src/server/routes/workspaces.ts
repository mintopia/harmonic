import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import type { WorkspaceRow } from '../../db/schema.js';
import type { ResolvedTracker } from '../../tracker/adapter.js';
import { createWorkspaceInputSchema, updateWorkspaceInputSchema } from '../../domain/workspaces.js';
import {
  verificationCommandOverrideSchema,
  verificationCriticOverrideSchema,
  budgetGuardrailSchema,
  unpricedModelsForCostCap,
  costCapMessage,
} from '../../config.js';
import { DomainError } from '../../domain/errors.js';
import { idParamsSchema, errorResponse } from '../schemas.js';

/**
 * The Resolved Tracker of a Workspace (issue #83), flattened for the API: a
 * display `label` when resolved, else a coded `reason` it can't. `null` when the
 * Workspace has tracking off (nothing to resolve). The `ok` flag discriminates
 * which of `label` / (`code`,`reason`) is populated.
 */
const resolvedTrackerSchema = z
  .object({
    ok: z.boolean().meta({ example: true }),
    label: z.string().nullable().meta({ example: 'GitHub' }),
    code: z.string().nullable().meta({ example: null }),
    reason: z.string().nullable().meta({ example: null }),
  })
  .nullable()
  .meta({ description: 'The tracker this Workspace resolved (issue #83), or null when tracking is off.' });

/** A Workspace (ADR-0008) as the API serves it — the `WorkspaceRow` plus the
 * `resolvedTracker` the route injects at serialize time (issue #83). */
const workspaceSchema = z
  .object({
    id: z.number().meta({ example: 1 }),
    name: z.string().meta({ example: 'Harmonic' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    trackerEnabled: z.boolean().meta({ example: false }),
    trackerPollIntervalSeconds: z.number().meta({ example: 60 }),
    resolvedTracker: resolvedTrackerSchema,
    // Per-workspace setting overrides (ADR-0012): null ⇒ inherit the global
    // default, a value overrides it. Resolved at read time (issue #60).
    harness: z.string().nullable().meta({ example: null }),
    model: z.string().nullable().meta({ example: null }),
    chatHarness: z.string().nullable().meta({ example: null }),
    chatModel: z.string().nullable().meta({ example: null }),
    isolationMode: z.string().nullable().meta({ example: null }),
    priority: z.string().nullable().meta({ example: null }),
    maxConcurrentRuns: z.number().nullable().meta({ example: null }),
    autoRunnerEnabled: z.boolean().nullable().meta({ example: null }),
    /** Per-workspace attempt cap; null inherits `config.maxAttempts`. */
    maxAttempts: z.number().nullable().meta({ example: null }),
    contextReuseTokenLimit: z.number().nullable().meta({ example: null }),
    // Verification verifier overrides (issue #132), tri-state (issue #174): the
    // raw JSON columns parsed back into their object shape, so a client reads a
    // set override the same shape it PATCHes. null ⇒ inherit
    // `config.verification.{command,critic}`; `{ off: true }` ⇒ explicitly
    // disabled for this Workspace.
    verificationCommand: verificationCommandOverrideSchema.nullable().meta({ example: null }),
    verificationCritic: verificationCriticOverrideSchema.nullable().meta({ example: null }),
    guardrailBudget: budgetGuardrailSchema.nullable().meta({ example: null }),
    guardrailProgress: z.boolean().nullable().meta({ example: null }),
    createdAt: z.number().meta({ example: 1784030400000 }),
    updatedAt: z.number().meta({ example: 1784032260000 }),
  })
  .meta({ id: 'Workspace' });

const workspacesListResponseSchema = z.object({ workspaces: z.array(workspaceSchema) });

export async function workspaceRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const serializeResolvedTracker = (r: ResolvedTracker | null) =>
    r === null
      ? null
      : r.ok
        ? { ok: true, label: r.label, code: null, reason: null }
        : { ok: false, label: null, code: r.code, reason: r.reason };

  /** A Workspace row plus its live Resolved Tracker, as every workspace endpoint returns it.
   * The two verifier overrides are stored as JSON text; parse them back so the
   * response carries the same object shape a client PATCHes (issue #132). */
  const serialize = (ws: WorkspaceRow) => ({
    ...ws,
    verificationCommand: ws.verificationCommand ? JSON.parse(ws.verificationCommand) : null,
    verificationCritic: ws.verificationCritic ? JSON.parse(ws.verificationCritic) : null,
    guardrailBudget: ws.guardrailBudget ? JSON.parse(ws.guardrailBudget) : null,
    resolvedTracker: serializeResolvedTracker(ctx.trackerManager.resolvedTracker(ws.id)),
  });

  app.get(
    '/workspaces',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'List Workspaces. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: workspacesListResponseSchema.describe('Every Workspace, oldest first.') },
      },
    },
    async () => ({ workspaces: (await ctx.workspaces.list()).map(serialize) }),
  );

  app.post(
    '/workspaces',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Create a Workspace: a named Working Directory, unique by absolute path. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: createWorkspaceInputSchema,
        response: {
          201: workspaceSchema.describe('The created Workspace.'),
          400: errorResponse('The payload failed validation, or the working directory does not exist.'),
          409: errorResponse('Another Workspace already uses that absolute path.'),
        },
      },
    },
    async (req, reply) => {
      const workspace = await ctx.workspaces.create(req.body);
      await ctx.trackerManager.sync();
      return reply.status(201).send(serialize(workspace));
    },
  );

  app.get(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'Get one Workspace. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: workspaceSchema.describe('The Workspace.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => serialize(await ctx.workspaces.get(req.params.id)),
  );

  app.patch(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Rename a Workspace or repoint its Working Directory. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: updateWorkspaceInputSchema,
        response: {
          200: workspaceSchema.describe('The updated Workspace.'),
          400: errorResponse('The payload failed validation, or the working directory does not exist.'),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('Another Workspace already uses that absolute path.'),
        },
      },
    },
    async (req) => {
      // The budget-override shape is schema-validated, but a cost cap with no
      // token fallback is only invalid relative to the *config's* models/prices
      // (issue #166) — the same rule the global config enforces (ADR-0019). The
      // field-pathed message lets the settings form surface it inline.
      if (req.body.guardrailBudget) {
        const unpriced = unpricedModelsForCostCap(req.body.guardrailBudget, ctx.configStore.get());
        if (unpriced.length > 0) {
          throw new DomainError('validation', `guardrailBudget.costUsd: ${costCapMessage(unpriced)}`);
        }
      }
      const workspace = await ctx.workspaces.update(req.params.id, req.body);
      await ctx.trackerManager.sync();
      return serialize(workspace);
    },
  );

  app.delete(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Delete a Workspace and everything on its board, stopping its tracker poll loop. Refuses a Workspace with a running Task; deleting the last Workspace is allowed. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          204: z.null().describe('The Workspace and its board were deleted.'),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('It has a running Task.'),
        },
      },
    },
    async (req, reply) => {
      await ctx.workspaces.delete(req.params.id);
      await ctx.trackerManager.sync();
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/workspaces/:id/tracker/refresh',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Force an immediate tracker poll for a Workspace — rescan its Working Directory and mirror any ticket changes onto the board now, instead of waiting for the next interval. Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: z.object({ ok: z.literal(true) }).describe('The tracker was re-polled.'),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('Tracking is not enabled for this Workspace.'),
          500: errorResponse('The tracker scan failed (e.g. an unreadable ticket directory).'),
        },
      },
    },
    async (req) => {
      const ws = await ctx.workspaces.get(req.params.id);
      if (!ws.trackerEnabled) throw new DomainError('conflict', `tracking is not enabled for workspace ${ws.id}`);
      await ctx.trackerManager.pollNow(ws.id);
      return { ok: true as const };
    },
  );
}
