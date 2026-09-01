import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';
import type { Epic } from '../../domain/epic-view.js';
import { parseUnifiedDiff, diffFilesResponseSchema } from './diff.js';

/** Path params for a whole-Epic action: the owning Workspace and the Epic's tracker ref. */
const epicParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
  epicRef: z.coerce.number().int().meta({ example: 42 }),
});

/** Path params for the read endpoints: the owning Workspace only (`GET …/epics`). */
const epicListParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
});

/** The `GET …/epics` querystring: the shared pagination fragment plus a
 * case-insensitive substring search over the Epic title (ADR-0045). */
const epicListQuerySchema = paginationQuerySchema.extend({
  q: z.string().optional().meta({ example: 'operator UI' }),
});

/**
 * `Epic` (`src/domain/epic-view.ts`) as the API serves it (issue #167, ADR-0026
 * — the frozen contract in `.notes/issue-167-dto-contract.md`). Server and web
 * (`web/src/epic-model.ts`/`web/src/types.ts`) implement this shape
 * identically; there is no codegen between them, so keep the two in lockstep.
 */
const epicMemberSchema = z
  .object({
    ref: z.number().int().meta({ example: 4821 }),
    title: z.string().meta({ example: 'Wire the peek modal' }),
    taskId: z.number().int().nullable().meta({ example: 12 }),
    state: z.string().nullable().meta({ example: 'working' }),
    escalated: z.boolean(),
    mergeStatus: z.enum(['completed', 'blocked', 'pending']).meta({ example: 'pending' }),
    ready: z.boolean(),
  })
  .meta({ id: 'EpicMember' });

const epicIntegrationSchema = z
  .object({
    branch: z.string().meta({ example: 'epic/42' }),
    exists: z.boolean(),
    tip: z.string().nullable().meta({ example: 'a1b2c3d' }),
  })
  .meta({ id: 'EpicIntegration' });

const epicVerificationSchema = z
  .object({ status: z.enum(['pass', 'fail', 'pending']).nullable() })
  .meta({ id: 'EpicVerification' });

const epicIntegrateStateSchema = z
  .object({
    inFlight: z.boolean(),
    held: z.string().nullable().meta({ example: 'already escalated for this member state; awaiting operator or a state change' }),
  })
  .meta({ id: 'EpicIntegrateState' });

const epicSchema = z
  .object({
    ref: z.number().int().meta({ example: 42 }),
    title: z.string().meta({ example: 'Parallel Epic operator UI' }),
    kind: z.enum(['map', 'spec']),
    description: z.string().meta({ example: 'Build the parallel-Epic operator UI …' }),
    createdAt: z.number().int().meta({ example: 1_756_000_000_000 }),
    updatedAt: z.number().int().nullable().meta({ example: 1_756_100_000_000 }),
    baseBranch: z.string().nullable().meta({ example: 'develop' }),
    dependsOn: z.array(z.number().int()),
    members: z.array(epicMemberSchema),
    ready: z.array(z.number().int()),
    integration: epicIntegrationSchema,
    verification: epicVerificationSchema,
    integrate: epicIntegrateStateSchema,
    foldedCount: z.number().int(),
    memberCount: z.number().int(),
  })
  .meta({ id: 'Epic' });

const epicsListResponseSchema = listResponse('epics', epicSchema);

/** `EpicIntegrateOutcome` (`execution/epic-integrate-git.ts`) as the API serves it — a discriminated union on `status`. */
const epicIntegrateOutcomeSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('integrated'), oid: z.string().meta({ example: 'a1b2c3d' }) }),
    z.object({ status: z.literal('blocked'), reason: z.string().meta({ example: 'member 4821 is not completed' }) }),
    z.object({
      status: z.literal('waiting'),
      reason: z.string().meta({ example: 'default branch is detached; deferring the integrate' }),
    }),
    z.object({ status: z.literal('escalated'), reason: z.string().meta({ example: 'whole-Epic verification failed' }) }),
    z.object({ status: z.literal('noop'), reason: z.string().meta({ example: 'no integration branch for this Epic' }) }),
    /** An integrate attempt for this Epic is already in flight; the caller re-submits later. */
    z.object({ status: z.literal('busy') }),
  ])
  .meta({ id: 'EpicIntegrateOutcome' });

const epicToApi = (epic: Epic): Epic => epic;

export async function epicRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/workspaces/:workspaceId/epics',
    {
      schema: {
        tags: ['Epics'],
        description:
          "Every derived Epic for a Workspace's last tracker poll scan (issue #167, ADR-0026), each folded with its " +
          'member merge state, integration-branch tip, and whole-Epic integrate/verification state. Searched (`q`, ' +
          'case-insensitive substring over the Epic title) and paginated (`limit`/`offset`, with a `total`). Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicListParamsSchema,
        querystring: epicListQuerySchema,
        response: {
          200: epicsListResponseSchema.describe("Every derived Epic for this Workspace's last scan (possibly empty)."),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.assertExists(req.params.workspaceId);
      const epics = await ctx.trackerManager.listEpics(req.params.workspaceId);
      const { limit, offset, q } = req.query;
      const needle = q?.trim().toLowerCase();
      const matched = needle ? epics.filter((e) => e.title.toLowerCase().includes(needle)) : epics;
      const { items, total } = paginate(matched.map(epicToApi), { limit, offset });
      return { epics: items, total };
    },
  );

  app.get(
    '/workspaces/:workspaceId/epics/:epicRef',
    {
      schema: {
        tags: ['Epics'],
        description:
          "One derived Epic by its tracker ref, from the Workspace's last poll scan (issue #167, ADR-0026). " +
          '404s when the scan derives no leaf-most Epic with that ref. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicParamsSchema,
        response: {
          200: epicSchema.describe('The derived Epic.'),
          404: errorResponse('No Workspace has that id, or its last scan derives no Epic with that ref.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.assertExists(req.params.workspaceId);
      const epic = await ctx.trackerManager.epicDetail(req.params.workspaceId, req.params.epicRef);
      if (!epic) {
        throw new DomainError('not_found', `no Epic ${req.params.epicRef} derived for workspace ${req.params.workspaceId}`);
      }
      return epicToApi(epic);
    },
  );

  app.post(
    '/workspaces/:workspaceId/epics/:epicRef/force-integrate',
    {
      schema: {
        tags: ['Epics'],
        description:
          "Force-integrate an Epic's ready subset: merge whatever is folded into its integration branch into the " +
          'default branch now, bypassing the all-members-completed gate — but not Verification, which still ' +
          'gates the merge. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicParamsSchema,
        response: {
          200: epicIntegrateOutcomeSchema.describe("The force-integrate attempt's outcome."),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('No active whole-Epic integrate coordinator for this Workspace (tracking is off or the loop has not started).'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.assertExists(req.params.workspaceId);
      const outcome = await ctx.trackerManager.forceIntegrateEpic(req.params.workspaceId, req.params.epicRef);
      if (!outcome) {
        throw new DomainError(
          'conflict',
          `no active whole-Epic integrate coordinator for workspace ${req.params.workspaceId} (tracking is off or the loop has not started)`,
        );
      }
      return outcome;
    },
  );

  app.get(
    '/workspaces/:workspaceId/epics/:epicRef/diff/files',
    {
      schema: {
        tags: ['Epics'],
        description:
          'Per-file unified-diff hunks for the whole-Epic diff panel (ADR-0018): what `epic/<ref>` changes over ' +
          'base while open, the frozen merge-commit diff once integrated (survives branch retirement). Paginated. ' +
          'Empty `files` for a branchless/no-op Epic. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: diffFilesResponseSchema.describe("The Epic's changed files with parsed +/- hunks; empty for a branchless/no-op Epic."),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.assertExists(req.params.workspaceId);
      const raw = await ctx.trackerManager.epicDiff(req.params.workspaceId, req.params.epicRef);
      const files = parseUnifiedDiff(raw);
      const { limit, offset } = req.query;
      const { items, total } = paginate(files, { limit, offset });
      return { files: items, total };
    },
  );
}
