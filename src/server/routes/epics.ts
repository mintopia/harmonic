import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { attemptUsageSchema, costSchema, errorResponse } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';
import type { Epic } from '../../domain/epic-view.js';
import { diffFilesResponseSchema } from './diff.js';
import { parseUnifiedDiff } from '../../domain/unified-diff.js';
import { epicAttemptTimelineToApi } from '../serialize.js';
import { ATTEMPT_STATES } from '../../db/schema.js';

/** Path params for a whole-Epic action: the owning Workspace and the Epic's tracker ref. */
const epicParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
  epicRef: z.coerce.number().int().meta({ example: 42 }),
});

/** Path params for the read endpoints: the owning Workspace only (`GET …/epics`). */
const epicListParamsSchema = z.object({
  workspaceId: z.coerce.number().int().meta({ example: 1 }),
});

const rejectEpicInputSchema = z.object({
  guidance: z.string().trim().min(1).meta({ example: 'Fix the failing integration test before trying again.' }),
  continuation: z.enum(['continue', 'fresh']).meta({ example: 'continue' }),
});

/** The `GET …/epics` querystring: the shared pagination fragment plus a
 * case-insensitive substring search over the Epic title. */
const epicListQuerySchema = paginationQuerySchema.extend({
  q: z.string().optional().meta({ example: 'operator UI' }),
});

/**
 * `Epic` (`src/domain/epic-view.ts`) as the API serves it. Server and web
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
  .object({ status: z.enum(['pass', 'fail', 'pending']).nullable(), configured: z.boolean(), stages: z.array(z.object({ label: z.string(), status: z.enum(['pass', 'fail', 'pending']).nullable(), verifiers: z.array(z.string()) })).optional() })
  .meta({ id: 'EpicVerification' });

const epicIntegrateStateSchema = z
  .object({
    inFlight: z.boolean(),
    held: z.string().nullable().meta({ example: 'already escalated for this member state; awaiting operator or a state change' }),
    phase: z
      .object({ phase: z.enum(['verifying', 'merging']), sinceMs: z.number().int() })
      .nullable()
      .meta({ example: { phase: 'verifying', sinceMs: 1080000 } }),
  })
  .meta({ id: 'EpicIntegrateState' });

const mergeStepSchema = z
  .discriminatedUnion('step', [
    z.object({ step: z.literal('started'), baseBranch: z.string(), taskBranch: z.string() }),
    z.object({ step: z.literal('conflict'), paths: z.array(z.string()) }),
    z.object({ step: z.literal('resolve-turn'), turn: z.number().int(), unmergedCount: z.number().int() }),
    z.object({ step: z.literal('post-check-skipped'), mergeOid: z.string() }),
    z.object({ step: z.literal('post-check-passed'), mergeOid: z.string() }),
    z.object({ step: z.literal('reverted'), mergeOid: z.string(), revertOid: z.string() }),
    z.object({ step: z.literal('merged'), mergeOid: z.string() }),
    z.object({ step: z.literal('escalated'), reason: z.enum(['conflict', 'post-merge-red']), message: z.string() }),
  ])
  .meta({ id: 'MergeStepEvent' });

const epicSchema = z
  .object({
    ref: z.number().int().meta({ example: 42 }),
    title: z.string().meta({ example: 'Parallel Epic operator UI' }),
    kind: z.enum(['map', 'spec']),
    state: z.enum(['open', 'integrated']),
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
    mergeSteps: z.array(mergeStepSchema),
    foldedCount: z.number().int(),
    memberCount: z.number().int(),
  })
  .meta({ id: 'Epic' });

const epicsListResponseSchema = listResponse('epics', epicSchema);

const verificationAttemptSchema = z.object({
  id: z.number().int(),
  attemptId: z.number().int(),
  seq: z.number().int(),
  ts: z.number().int(),
  mechanism: z.enum(['critic', 'command']),
  inputOid: z.string(),
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  summary: z.string(),
  output: z.string(),
  prompt: z.string().nullable(),
  harness: z.string().nullable(),
  hasTranscript: z.boolean(),
});

const epicAttemptSchema = z
  .object({
    id: z.number().int(),
    number: z.number().int().positive(),
    state: z.enum(ATTEMPT_STATES),
    reason: z.string().nullable(),
    prompt: z.string().nullable(),
    usage: attemptUsageSchema.nullable(),
    cost: costSchema.nullable(),
    toolCalls: z.number().int().nonnegative(),
    contextTokens: z.number().nullable(),
    startedAt: z.number().int(),
    endedAt: z.number().int().nullable(),
    steps: z.array(z.object({
      id: z.number().int(),
      attemptId: z.number().int(),
      type: z.enum(['rebase', 'implementation', 'verification', 'review']),
      position: z.number().int(),
      state: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled']),
      command: z.string().nullable(),
      verdict: z.string().nullable(),
      logLocator: z.string().nullable(),
      startedAt: z.number().int().nullable(),
      endedAt: z.number().int().nullable(),
    })),
    verificationAttempts: z.array(verificationAttemptSchema),
  })
  .meta({ id: 'EpicAttempt' });

const epicAttemptTimelineResponseSchema = z
  .object({ attempts: z.array(epicAttemptSchema) })
  .meta({ id: 'EpicAttemptTimelineResponse' });

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

export async function epicRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/workspaces/:workspaceId/epics',
    {
      schema: {
        tags: ['Epics'],
        description:
          "Every open Epic for a Workspace (issue #167, ADR-0018) — an integrated Epic leaves this list and resolves by ref only — each folded with its " +
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
          "One derived Epic by its tracker ref, from the Workspace's last poll scan (issue #167). " +
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

  app.get(
    '/workspaces/:workspaceId/epics/:epicRef/attempts',
    {
      schema: {
        tags: ['Epics'],
        description: 'Every durable Attempt owned by this Epic, ordered by its Epic-local timeline number. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicParamsSchema,
        response: {
          200: epicAttemptTimelineResponseSchema.describe('The Epic Attempt timeline with durable usage and frozen cost.'),
          404: errorResponse('No Workspace has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.assertExists(req.params.workspaceId);
      return epicAttemptTimelineToApi(ctx, req.params);
    },
  );

  app.post(
    '/workspaces/:workspaceId/epics/:epicRef/reject',
    {
      schema: {
        tags: ['Epics'],
        description: 'Reject an escalated Epic with guidance. The guidance is recorded on the escalated Epic Attempt and included in the next whole-Epic resolver turn. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicParamsSchema,
        body: rejectEpicInputSchema,
        response: {
          200: epicIntegrateOutcomeSchema.describe('The outcome of rejecting the Epic and requeuing it with operator guidance.'),
          404: errorResponse('No Workspace has that id.'),
          409: errorResponse('The Epic is not escalated or has no active whole-Epic coordinator.'),
        },
      },
    },
    async (req) => {
      await ctx.workspaces.assertExists(req.params.workspaceId);
      const outcome = await ctx.trackerManager.rejectEpic(req.params.workspaceId, req.params.epicRef, req.body.guidance, req.body.continuation);
      if (!outcome) throw new DomainError('conflict', `Epic ${req.params.epicRef} is not escalated`);
      return outcome;
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
