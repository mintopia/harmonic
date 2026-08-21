import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse } from '../schemas.js';
import type { Epic } from '../../domain/epic-view.js';

/** Path params for a whole-Epic action: the owning Workspace and the Epic's tracker ref. */
const epicParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
  epicRef: z.coerce.number().int().meta({ example: 42 }),
});

/** Path params for the read endpoints: the owning Workspace only (`GET …/epics`). */
const epicListParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
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
    state: z.string().nullable().meta({ example: 'running' }),
    escalated: z.boolean(),
    landStatus: z.enum(['completed', 'blocked', 'pending']).meta({ example: 'pending' }),
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

const epicLandStateSchema = z
  .object({
    inFlight: z.boolean(),
    held: z.string().nullable().meta({ example: 'already escalated for this member state; awaiting operator or a state change' }),
  })
  .meta({ id: 'EpicLandState' });

const epicSchema = z
  .object({
    ref: z.number().int().meta({ example: 42 }),
    title: z.string().meta({ example: 'Parallel Epic operator UI' }),
    kind: z.enum(['map', 'spec']),
    members: z.array(epicMemberSchema),
    ready: z.array(z.number().int()),
    integration: epicIntegrationSchema,
    verification: epicVerificationSchema,
    land: epicLandStateSchema,
    foldedCount: z.number().int(),
    memberCount: z.number().int(),
  })
  .meta({ id: 'Epic' });

const epicsListResponseSchema = z.object({ epics: z.array(epicSchema) });

/** `EpicLandOutcome` (`execution/epic-land-coordinator.ts`) as the API serves it — a discriminated union on `status`. */
const epicLandOutcomeSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('landed'), oid: z.string().meta({ example: 'a1b2c3d' }) }),
    z.object({ status: z.literal('blocked'), reason: z.string().meta({ example: 'member 4821 is not completed' }) }),
    z.object({
      status: z.literal('waiting'),
      reason: z.string().meta({ example: 'default branch is detached; deferring the land' }),
    }),
    z.object({ status: z.literal('escalated'), reason: z.string().meta({ example: 'whole-Epic verification failed' }) }),
    z.object({ status: z.literal('noop'), reason: z.string().meta({ example: 'no integration branch for this Epic' }) }),
    /** A land attempt for this Epic is already in flight; the caller re-submits later. */
    z.object({ status: z.literal('busy') }),
  ])
  .meta({ id: 'EpicLandOutcome' });

/**
 * The operator force-land-the-ready-subset action over a whole Epic (issue
 * #161, ADR-0024): land whatever subset is currently folded into the Epic's
 * integration branch into the default branch now, even though a sibling
 * member is stuck — explicit and never automatic. Verification still gates
 * the merge (a failing whole-Epic Verification escalates rather than
 * landing); this only bypasses the all-members-`completed` gate.
 *
 * Mirrors the lease operator-action shape (`routes/leases.ts`, issue #125):
 * operator only, not on `scopedKeyAllowed`'s (or `readScopeAllowed`'s)
 * allowlist, so a run-scoped or read-scoped key gets the same 403 an
 * unrecognized path gets by default (see app.ts).
 */
/** `Epic` (`src/domain/epic-view.ts`) passed straight through — the domain
 * shape already *is* the frozen DTO, so there is nothing to reshape; kept as
 * a named identity so a future divergence between the two has one seam to
 * change rather than two call sites drifting apart. */
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
          'member land state, integration-branch tip, and whole-Epic land/verification state. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicListParamsSchema,
        response: {
          200: epicsListResponseSchema.describe("Every derived Epic for this Workspace's last scan (possibly empty)."),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.get(req.params.workspaceId); // 404s an unknown Workspace before touching the tracker
      const epics = await ctx.trackerManager.listEpics(req.params.workspaceId);
      return { epics: epics.map(epicToApi) };
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
      await ctx.workspaces.get(req.params.workspaceId); // 404s an unknown Workspace before touching the tracker
      const epic = await ctx.trackerManager.epicDetail(req.params.workspaceId, req.params.epicRef);
      if (!epic) {
        throw new DomainError('not_found', `no Epic ${req.params.epicRef} derived for workspace ${req.params.workspaceId}`);
      }
      return epicToApi(epic);
    },
  );

  app.post(
    '/workspaces/:workspaceId/epics/:epicRef/force-land',
    {
      schema: {
        tags: ['Epics'],
        description:
          "Force-land an Epic's ready subset: merge whatever is folded into its integration branch into the " +
          'default branch now, bypassing the all-members-completed gate — but not Verification, which still ' +
          'gates the merge. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicParamsSchema,
        response: {
          200: epicLandOutcomeSchema.describe("The force-land attempt's outcome."),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('No active whole-Epic land coordinator for this Workspace (tracking is off or the loop has not started).'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.get(req.params.workspaceId); // 404s an unknown Workspace before touching the tracker
      const outcome = await ctx.trackerManager.forceLandEpic(req.params.workspaceId, req.params.epicRef);
      if (!outcome) {
        throw new DomainError(
          'conflict',
          `no active whole-Epic land coordinator for workspace ${req.params.workspaceId} (tracking is off or the loop has not started)`,
        );
      }
      return outcome;
    },
  );
}
