import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TrackingContext } from '../app.js';
import type { WorkspaceRow } from '../../db/schema.js';
import type { ResolvedTracker } from '../../tracker/adapter.js';
import { PROMPT_FRAGMENT_OVERRIDE_KEYS, type PromptFragmentOverrideKey } from '../../domain/prompt-fragments.js';
import { createWorkspaceInputSchema, updateWorkspaceInputSchema, codeRepositorySchema } from '../../domain/workspaces.js';
import { configuredTrackerSchema } from '../../tracker/configured.js';
import { triageLabelsOverrideSchema } from '../../tracker/triage-labels.js';
import { EXPORT_STATES, redactPatternsSchema } from '../../config.js';
import {
  verificationCommandOverrideSchema,
  routingLabelOverrideSchema,
  taskVerificationCriticOverrideSchema,
  epicVerificationCriticOverrideSchema,
  budgetGuardrailSchema,
  unpricedModelsForCostCap,
  criticModelMessage,
  costCapMessage,
} from '../../config.js';
import { forEachYielding } from '../../reliability/yield.js';
import { requestActor } from '../operator-inputs.js';
import { requestIsOperator } from '../auth.js';
import type { AppContext } from '../app.js';
import { resolveScoped, routingLabelIssueMessage, routingLabelOverlayIssues } from '../../domain/setting-override.js';
import { parseRoutingLabelOverlay } from '../../domain/routing-labels.js';
import { DomainError } from '../../domain/errors.js';
import { idParamsSchema, errorResponse } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';
import { maskWorkspaceSecrets } from '../../archive/export-secrets.js';

/** The Resolved Tracker flattened for the API; `null` when tracking is off. `ok` discriminates `label` vs (`code`, `reason`). */
const resolvedTrackerSchema = z
  .object({
    ok: z.boolean().meta({ example: true }),
    label: z.string().nullable().meta({ example: 'GitHub' }),
    kind: z.string().nullable().meta({ example: 'github' }),
    source: z.enum(['configured', 'detected', 'code-repository']).nullable().meta({ example: 'detected' }),
    code: z.string().nullable().meta({ example: null }),
    reason: z.string().nullable().meta({ example: null }),
  })
  .nullable()
  .meta({ description: 'The tracker this Workspace resolved (issue #83), or null when tracking is off.' });

const promptFragmentOverrideResponseShape = Object.fromEntries(
  PROMPT_FRAGMENT_OVERRIDE_KEYS.map((key) => [key, z.string().nullable().meta({ example: null })]),
) as Record<PromptFragmentOverrideKey, z.ZodNullable<z.ZodString>>;

/** A Workspace as the API serves it: the `WorkspaceRow` plus its `resolvedTracker`. */
const workspaceSchema = z
  .object({
    id: z.number().meta({ example: 1 }),
    name: z.string().meta({ example: 'Harmonic' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    color: z.string().regex(/^#[0-9A-F]{6}$/i).meta({ example: '#FA6152' }),
    trackerEnabled: z.boolean().meta({ example: false }),
    trackerPollIntervalSeconds: z.number().meta({ example: 60 }),
    excludedDirectories: z.array(z.string()).meta({ example: ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', 'out', 'target'] }),
    resolvedTracker: resolvedTrackerSchema,
    // Setting overrides: null ⇒ inherit the global default.
    harness: z.string().nullable().meta({ example: null }),
    model: z.string().nullable().meta({ example: null }),
    chatHarness: z.string().nullable().meta({ example: null }),
    chatModel: z.string().nullable().meta({ example: null }),
    isolationMode: z.string().nullable().meta({ example: null }),
    priority: z.string().nullable().meta({ example: null }),
    /** Conflict-resolve-turn bound; null inherits `config.defaults.conflictResolveTurns`. */
    conflictResolveTurns: z.number().nullable().meta({ example: null }),
    maxConcurrentAttempts: z.number().nullable().meta({ example: null }),
    autoRunnerEnabled: z.boolean().nullable().meta({ example: null }),
    agentMessagesEnabled: z.boolean().nullable().meta({ example: null }),
    agentMessagesSendCap: z.number().nullable().meta({ example: null }),
    /** Whether Agent Messages are on for this Workspace after Baseline → Global → Workspace resolution. */
    effectiveAgentMessagesEnabled: z.boolean().meta({ example: false }),
    /** Per-workspace attempt cap; null inherits `config.maxAttempts`. */
    maxAttempts: z.number().nullable().meta({ example: null }),
    contextReuseTokenLimit: z.number().nullable().meta({ example: null }),
    taskPreMergeCommands: verificationCommandOverrideSchema.nullable().meta({ example: null }),
    taskPreMergeCritics: taskVerificationCriticOverrideSchema.nullable().meta({ example: null }),
    taskPostMergeCommands: verificationCommandOverrideSchema.nullable().meta({ example: null }),
    taskPostMergeCritics: taskVerificationCriticOverrideSchema.nullable().meta({ example: null }),
    epicPreMergeCommands: verificationCommandOverrideSchema.nullable().meta({ example: null }),
    epicPreMergeCritics: epicVerificationCriticOverrideSchema.nullable().meta({ example: null }),
    /** Routing Label overlay; null inherits every global Routing Label in order. */
    routingLabels: routingLabelOverrideSchema.nullable().meta({ example: null }),
    guardrailBudget: budgetGuardrailSchema.nullable().meta({ example: null }),
    guardrailProgress: z.boolean().nullable().meta({ example: null }),
    /** Tool-timeout bound override; null inherits `config.guardrails.toolTimeoutMinutes`. */
    toolTimeoutMinutes: z.number().nullable().meta({ example: null }),
    // Drive.* overrides: each null ⇒ inherit the matching `config.drive.*`.
    drivePrompt: z.string().nullable().meta({ example: null }),
    driveUnattendedReminder: z.string().nullable().meta({ example: null }),
    driveContinuePrompt: z.string().nullable().meta({ example: null }),
    driveMergeFate: z.string().nullable().meta({ example: null }),
    driveContinueAttempts: z.number().nullable().meta({ example: null }),
    /** Task Prompt override; null inherits `config.taskPrompt`. */
    taskPrompt: z.string().nullable().meta({ example: null }),
    /** Pause message override; null inherits `config.pauseMessage`. */
    pauseMessage: z.string().nullable().meta({ example: null }),
    ...promptFragmentOverrideResponseShape,
    /** Commit nudge override; null inherits `config.drive.commitNudge`. */
    driveCommitNudge: z.string().nullable().meta({ example: null }),
    /** Task merge-conflict prompt override; null inherits `config.merge.conflictPrompt`. */
    mergeConflictPrompt: z.string().nullable().meta({ example: null }),
    /** Epic integration merge-conflict prompt override; null inherits `config.merge.epicConflictPrompt`. */
    mergeEpicConflictPrompt: z.string().nullable().meta({ example: null }),
    mergeEpicRefreshPrompt: z.string().nullable().meta({ example: null }),
    verifyEpicResolveSuffix: z.string().nullable().meta({ example: null }),
    exportEnabled: z.boolean().nullable().meta({ example: null }),
    exportDirectoryPath: z.string().nullable().meta({ example: null }),
    exportS3Endpoint: z.string().nullable().meta({ example: null }),
    exportS3Region: z.string().nullable().meta({ example: null }),
    exportS3Bucket: z.string().nullable().meta({ example: null }),
    exportS3Prefix: z.string().nullable().meta({ example: null }),
    exportS3ForcePathStyle: z.boolean().nullable().meta({ example: null }),
    /** Masked when set: a set key is always returned as the mask, never the value. */
    exportS3AccessKeyId: z.string().nullable().meta({ example: null }),
    exportS3SecretAccessKey: z.string().nullable().meta({ example: null }),
    exportRedactPatterns: redactPatternsSchema.nullable().meta({ example: null }),
    exportIncludeStates: z.array(z.enum(EXPORT_STATES)).nullable().meta({ example: null }),
    configuredTracker: configuredTrackerSchema.nullable().meta({ example: null }),
    codeRepository: codeRepositorySchema.nullable().meta({ example: null }),
    triageLabels: triageLabelsOverrideSchema.nullable().meta({ example: null }),
    archiveRetentionDays: z.number().nullable().meta({ example: null }),
    archiveRetentionMaxTotalMB: z.number().nullable().meta({ example: null }),
    createdAt: z.number().meta({ example: 1784030400000 }),
    updatedAt: z.number().meta({ example: 1784032260000 }),
  })
  .meta({ id: 'Workspace' });

const workspaceSummarySchema = workspaceSchema.pick({ id: true, name: true, color: true }).meta({ id: 'WorkspaceSummary' });

const workspacesListResponseSchema = listResponse('workspaces', workspaceSchema);
const workspaceSummariesListResponseSchema = listResponse('workspaces', workspaceSummarySchema);

export async function workspaceRoutes(fastify: FastifyInstance, ctx: Pick<TrackingContext, 'workspaces' | 'settingsStore' | 'trackerManager' | 'workspaceWatcher'> & Pick<AppContext, 'auth' | 'tasks' | 'archive'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const serializeResolvedTracker = (r: ResolvedTracker | null) =>
    r === null
      ? null
      : r.ok
        ? { ok: true, label: r.label, kind: r.name, source: r.source, code: null, reason: null }
        : { ok: false, label: null, kind: null, source: null, code: r.code, reason: r.reason };

  /** A Workspace row plus its live Resolved Tracker; JSON-text override columns parsed back to the shape a client PATCHes. */
  const serialize = (ws: WorkspaceRow) => ({
    ...maskWorkspaceSecrets(ws),
    taskPreMergeCommands: ws.taskPreMergeCommands ? JSON.parse(ws.taskPreMergeCommands) : null,
    taskPreMergeCritics: ws.taskPreMergeCritics ? JSON.parse(ws.taskPreMergeCritics) : null,
    taskPostMergeCommands: ws.taskPostMergeCommands ? JSON.parse(ws.taskPostMergeCommands) : null,
    taskPostMergeCritics: ws.taskPostMergeCritics ? JSON.parse(ws.taskPostMergeCritics) : null,
    epicPreMergeCommands: ws.epicPreMergeCommands ? JSON.parse(ws.epicPreMergeCommands) : null,
    epicPreMergeCritics: ws.epicPreMergeCritics ? JSON.parse(ws.epicPreMergeCritics) : null,
    routingLabels: parseRoutingLabelOverlay(ws.routingLabels),
    exportRedactPatterns: ws.exportRedactPatterns ? JSON.parse(ws.exportRedactPatterns) : null,
    exportIncludeStates: ws.exportIncludeStates ? JSON.parse(ws.exportIncludeStates) : null,
    configuredTracker: ws.configuredTracker ? JSON.parse(ws.configuredTracker) : null,
    triageLabels: ws.triageLabels ? JSON.parse(ws.triageLabels) : null,
    guardrailBudget: ws.guardrailBudget ? JSON.parse(ws.guardrailBudget) : null,
    effectiveAgentMessagesEnabled: resolveScoped('agentMessagesEnabled', ws.agentMessagesEnabled, ctx.settingsStore.getGlobal().agentMessages.enabled),
    resolvedTracker: serializeResolvedTracker(ctx.trackerManager.resolvedTracker(ws.id)),
  });

  app.get(
    '/workspaces',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'List Workspaces. A read-scoped key is served only the id, name and color of each Workspace (never its config).',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: paginationQuerySchema,
        response: {
          200: z
            .union([workspacesListResponseSchema, workspaceSummariesListResponseSchema])
            .describe('Every Workspace, oldest first: the full Workspace for an operator or full-scope key, id/name/color only for a read-scoped key.'),
        },
      },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const rows = await ctx.workspaces.list();
      if (!(await requestIsOperator(req, ctx.auth))) {
        const { items, total } = paginate(rows.map(({ id, name, color }) => ({ id, name, color })), { limit, offset });
        return { workspaces: items, total };
      }
      const { items, total } = paginate(rows.map(serialize), { limit, offset });
      return { workspaces: items, total };
    },
  );

  app.post(
    '/workspaces',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Create a Workspace: a named Working Directory, unique by absolute path.',
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
      await ctx.workspaceWatcher.sync(await ctx.workspaces.list());
      return reply.status(201).send(serialize(workspace));
    },
  );

  app.get(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'Get one Workspace.',
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
          'Rename a Workspace or repoint its Working Directory.',
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
      const harnesses = ctx.settingsStore.getGlobal().harnesses;
      if (req.body.routingLabels) {
        const first = routingLabelOverlayIssues(req.body.routingLabels, ctx.settingsStore.getGlobal().routingLabels)[0];
        if (first) {
          const entry = req.body.routingLabels[first.index];
          const label = entry?.kind === 'local' ? entry.routingLabel.label : '';
          throw new DomainError('validation', `routingLabels.${first.index}.routingLabel.label: ${routingLabelIssueMessage(first, label)}`);
        }
        req.body.routingLabels.forEach((entry, index) => {
          if (entry.kind === 'local' && !harnesses[entry.routingLabel.harness]) {
            throw new DomainError('validation', `routingLabels.${index}.routingLabel.harness: harness '${entry.routingLabel.harness}' is not configured`);
          }
        });
      }
      for (const [key, list] of [['taskPreMergeCritics', req.body.taskPreMergeCritics], ['taskPostMergeCritics', req.body.taskPostMergeCritics], ['epicPreMergeCritics', req.body.epicPreMergeCritics]] as const) {
        list?.forEach((entry, index) => {
          if (entry.kind !== 'local') return;
          const models = harnesses[entry.critic.harness]?.models ?? [];
          if (models.length > 0 && !models.some((m) => m.id === entry.critic.model)) {
            throw new DomainError('validation', `${key}.${index}.critic.model: ${criticModelMessage(entry.critic)}`);
          }
        });
      }
      if (req.body.guardrailBudget) {
        const unpriced = unpricedModelsForCostCap(req.body.guardrailBudget, ctx.settingsStore.getGlobal());
        if (unpriced.length > 0) {
          throw new DomainError('validation', `guardrailBudget.costUsd: ${costCapMessage(unpriced)}`);
        }
      }
      const workspace = await ctx.workspaces.update(req.params.id, req.body);
      await ctx.trackerManager.sync();
      await ctx.workspaceWatcher.sync(await ctx.workspaces.list());
      return serialize(workspace);
    },
  );

  app.delete(
    '/workspaces/:id',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Delete a Workspace and everything on its board, stopping its tracker poll loop. Refuses a Workspace with a running Task; deleting the last Workspace is allowed.',
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
      const actor = await requestActor(req, ctx);
      const archived: Array<{ dir: string; taskId: number }> = [];
      await forEachYielding(await ctx.tasks.list({ workspaceId: req.params.id }), async (task) => {
        const dir = await ctx.archive.existingDir(task);
        if (dir) archived.push({ dir, taskId: task.id });
      });
      await ctx.workspaces.delete(req.params.id);
      await forEachYielding(archived, ({ dir, taskId }) => ctx.archive.markDeleted(dir, actor, taskId));
      await ctx.trackerManager.sync();
      await ctx.workspaceWatcher.sync(await ctx.workspaces.list());
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/workspaces/:id/tracker/refresh',
    {
      schema: {
        tags: ['Workspaces'],
        description:
          'Force an immediate tracker poll for a Workspace — rescan its Working Directory and mirror any ticket changes onto the board now, instead of waiting for the next interval.',
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
