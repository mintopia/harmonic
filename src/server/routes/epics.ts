import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse } from '../schemas.js';

/** Path params for a whole-Epic action: the owning Workspace and the Epic's tracker ref. */
const epicParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
  epicRef: z.coerce.number().int().meta({ example: 42 }),
});

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
export async function epicRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

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
      ctx.workspaces.get(req.params.workspaceId); // 404s an unknown Workspace before touching the tracker
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
