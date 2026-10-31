import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PersistenceContext } from '../app.js';
import {
  createExecutionTargetSchema,
  credentialValueSchema,
  kubeconfigSchema,
  updateExecutionTargetSchema,
  executionTargetFieldsSchema,
} from '../../execution/execution-targets.js';
import { HARNESS_IDS } from '../../config.js';
import { CONNECTION_OUTCOMES } from '../../execution/kubernetes-client.js';
import { describeWorkspaceTargets } from '../../execution/workspace-execution-targets.js';
import { idParamsSchema, errorResponse } from '../schemas.js';
import { listResponse } from '../pagination.js';

const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];

const targetParamsSchema = z.object({ name: z.string().min(1).max(64).meta({ example: 'k8s-prod' }) });

const kubeconfigStatusSchema = z
  .object({
    set: z.boolean().meta({ example: true }),
    secretName: z.string().nullable().meta({ example: 'k8s-prod-kubeconfig' }),
    updatedAt: z.number().nullable().meta({ example: 1784030400000 }),
  })
  .meta({ id: 'ExecutionTargetKubeconfig', description: 'Whether the kubeconfig Secret is set. The kubeconfig itself is write-only and never returned.' });

const credentialStatusSchema = z
  .object({
    harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }),
    kind: z.enum(['oauth-token', 'api-key']).meta({ example: 'oauth-token', description: 'Claude takes a `claude setup-token` value; the other Harnesses take an API key.' }),
    harnessConfigured: z.boolean().meta({ example: true, description: 'Whether the Harness is configured in Harmonic; only configured Harnesses get their credential injected.' }),
    set: z.boolean().meta({ example: true }),
    secretName: z.string().meta({ example: 'k8s-prod-claude-token' }),
    updatedAt: z.string().nullable().meta({ example: '2026-10-31T12:00:00.000Z' }),
  })
  .meta({ id: 'ExecutionTargetCredential', description: 'Whether a Harness credential Secret is set on the target. The value is write-only and never returned.' });

const credentialParamsSchema = targetParamsSchema.extend({ harness: z.enum(HARNESS_IDS).meta({ example: 'claude' }) });

const proxyKeyStatusSchema = z
  .object({
    set: z.boolean().meta({ example: true }),
    secretName: z.string().meta({ example: 'k8s-prod-proxy-key' }),
    rotatedAt: z.number().nullable().meta({ example: 1784030400000, description: 'When the signing key was last created or rotated.' }),
  })
  .meta({ id: 'ExecutionTargetProxyKey', description: 'Whether the Repository Proxy signing key Secret is set. The key is never returned except once by rotation.' });

const proxyKeyRotationSchema = z
  .object({
    key: z.string().meta({ example: 'Zm9v...', description: 'The new signing key. Shown only in this response; copy it to the Repository Proxy.' }),
    rotatedAt: z.number().meta({ example: 1784030400000 }),
    revokedRunning: z.number().meta({ example: 2, description: 'Tickets running on the target whose pass is now revoked.' }),
  })
  .meta({ id: 'ExecutionTargetProxyKeyRotation' });

const executionTargetSchema = z
  .object({
    name: z.string().meta({ example: 'k8s-prod' }),
    builtIn: z.boolean().meta({ example: false, description: 'True only for `local`, which is not editable.' }),
    enabled: z.boolean().meta({ example: true }),
    authMethod: z.enum(['kubeconfig', 'in-cluster']).nullable().meta({ example: 'kubeconfig' }),
    namespace: z.string().nullable().meta({ example: 'harmonic-agents' }),
    defaultImage: z.string().nullable().meta({ example: 'ghcr.io/mintopia/harmonic-harnesses:2.19.0' }),
    cpu: z.string().nullable().meta({ example: '2' }),
    memory: z.string().nullable().meta({ example: '4Gi' }),
    concurrencyLimit: z.number().nullable().meta({ example: 4 }),
    repositoryProxyUrl: z.string().nullable().meta({ example: 'https://repo-proxy.harmonic-agents.svc.cluster.local' }),
    kubeconfig: kubeconfigStatusSchema.nullable(),
    proxyKey: proxyKeyStatusSchema.nullable(),
    credentials: z.array(credentialStatusSchema).describe('One entry per Harness; empty for `local`.'),
    running: z.number().meta({ example: 0, description: 'Tickets currently running on this target.' }),
    createdAt: z.number().nullable().meta({ example: 1784030400000 }),
    updatedAt: z.number().nullable().meta({ example: 1784030400000 }),
  })
  .meta({ id: 'ExecutionTarget', description: 'An Execution Target. `local` (the Harmonic host) is always listed first with `builtIn: true` and null Kubernetes fields.' });

const deletionImpactSchema = z
  .object({ running: z.number().meta({ example: 2 }), waiting: z.number().meta({ example: 1 }), total: z.number().meta({ example: 3 }) })
  .meta({ id: 'ExecutionTargetDeletionImpact', description: 'Tickets that escalate when the target is deleted: running on it plus waiting for it.' });

const connectionResultSchema = z
  .object({
    ok: z.boolean().meta({ example: true }),
    outcome: z.enum(CONNECTION_OUTCOMES).meta({ example: 'connected' }),
    message: z.string().meta({ example: 'Connected: listed namespace harmonic-agents (6 pods)' }),
    podCount: z.number().optional().meta({ example: 6 }),
    namespace: z.string().meta({ example: 'harmonic-agents' }),
    secretName: z.string().nullable().meta({ example: 'k8s-prod-kubeconfig' }),
  })
  .meta({ id: 'ExecutionTargetConnectionResult', description: 'The connection test outcome; a failure is still a 200 with `ok: false`.' });

const draftBodySchema = z
  .object({
    name: z.string().min(1).max(64).optional().meta({ example: 'k8s-prod', description: 'Existing target whose stored kubeconfig Secret is used when `kubeconfig` is omitted.' }),
    authMethod: executionTargetFieldsSchema.shape.authMethod,
    namespace: executionTargetFieldsSchema.shape.namespace,
    kubeconfig: kubeconfigSchema.optional().meta({ description: 'Unsaved kubeconfig to test; never stored by this call.' }),
  })
  .meta({ id: 'ExecutionTargetDraftConnectionTest' });

const workspaceTargetsSchema = z
  .object({
    restricted: z.boolean().meta({ example: true, description: 'False when the Workspace inherits every enabled target.' }),
    codeRepository: z.string().nullable().meta({ example: 'github' }),
    isolationMode: z.enum(['direct', 'worktree']).meta({ example: 'worktree' }),
    targets: z.array(
      z.object({
        name: z.string().meta({ example: 'k8s-prod' }),
        builtIn: z.boolean(),
        globallyEnabled: z.boolean(),
        allowed: z.boolean().meta({ description: 'In the Workspace allow-list, or inherited.' }),
        effective: z.boolean().meta({ description: 'Allowed, enabled globally and usable by this Workspace.' }),
        ineffectiveReason: z.string().nullable(),
        refusal: z.string().nullable().meta({ description: 'Why enabling this target for the Workspace would be refused; null when it would be accepted.' }),
      }),
    ),
  })
  .meta({ id: 'WorkspaceExecutionTargets' });

export async function executionTargetRoutes(fastify: FastifyInstance, ctx: Pick<PersistenceContext, 'executionTargets' | 'workspaces' | 'settingsStore'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const tags = ['Execution Targets'];

  app.get(
    '/execution-targets',
    {
      schema: {
        tags,
        description: 'List Execution Targets: the built-in `local` first, then every Kubernetes target.',
        security,
        response: { 200: listResponse('targets', executionTargetSchema).describe('Every Execution Target.') },
      },
    },
    async () => {
      const targets = await ctx.executionTargets.listWithLocal();
      return { targets, total: targets.length };
    },
  );

  app.post(
    '/execution-targets',
    {
      schema: {
        tags,
        description: 'Add a Kubernetes Execution Target. Set its kubeconfig afterwards with `PUT /execution-targets/:name/kubeconfig`.',
        security,
        body: createExecutionTargetSchema,
        response: {
          201: executionTargetSchema.describe('The created target.'),
          400: errorResponse('The payload failed validation, or the name is `local`.'),
          409: errorResponse('A target with that name already exists.'),
        },
      },
    },
    async (req, reply) => reply.status(201).send(await ctx.executionTargets.create(req.body)),
  );

  app.post(
    '/execution-targets/test-connection',
    {
      schema: {
        tags,
        description: 'Test unsaved target settings: list pods in the namespace with a 10 second timeout. Nothing is created or stored.',
        security,
        body: draftBodySchema,
        response: { 200: connectionResultSchema.describe('The outcome.'), 404: errorResponse('The named target does not exist.') },
      },
    },
    async (req) => {
      if (req.body.name) await ctx.executionTargets.get(req.body.name);
      return ctx.executionTargets.testDraft(req.body);
    },
  );

  app.get(
    '/execution-targets/:name',
    {
      schema: {
        tags,
        description: 'Get one Execution Target. The kubeconfig is never returned, only whether it is set.',
        security,
        params: targetParamsSchema,
        response: { 200: executionTargetSchema.describe('The target.'), 404: errorResponse('No target has that name.') },
      },
    },
    async (req) => ctx.executionTargets.get(req.params.name),
  );

  app.patch(
    '/execution-targets/:name',
    {
      schema: {
        tags,
        description:
          'Edit a Kubernetes target, or enable or disable it with `enabled`. Disabling keeps waiting Tickets ready. Renaming also renames its kubeconfig Secret and updates Workspace allow-lists; switching to `in-cluster` removes the stored kubeconfig.',
        security,
        params: targetParamsSchema,
        body: updateExecutionTargetSchema,
        response: {
          200: executionTargetSchema.describe('The updated target.'),
          400: errorResponse('The payload failed validation.'),
          404: errorResponse('No target has that name.'),
          409: errorResponse('`local` is built in, or the new name is taken.'),
        },
      },
    },
    async (req) => ctx.executionTargets.update(req.params.name, req.body),
  );

  app.get(
    '/execution-targets/:name/deletion-impact',
    {
      schema: {
        tags,
        description: 'How many Tickets would escalate if the target were deleted: running on it plus waiting for it.',
        security,
        params: targetParamsSchema,
        response: { 200: deletionImpactSchema.describe('The Ticket counts.'), 404: errorResponse('No target has that name.') },
      },
    },
    async (req) => ctx.executionTargets.deletionImpact(req.params.name),
  );

  app.delete(
    '/execution-targets/:name',
    {
      schema: {
        tags,
        description: 'Delete a Kubernetes target, its stored kubeconfig Secret, and its name in every Workspace allow-list.',
        security,
        params: targetParamsSchema,
        response: {
          200: z.object({ ok: z.literal(true), escalated: deletionImpactSchema }).describe('Deleted; `escalated` counts the Tickets that escalate because of it.'),
          404: errorResponse('No target has that name.'),
          409: errorResponse('`local` is built in and cannot be deleted.'),
        },
      },
    },
    async (req) => ({ ok: true as const, escalated: await ctx.executionTargets.delete(req.params.name) }),
  );

  app.put(
    '/execution-targets/:name/kubeconfig',
    {
      schema: {
        tags,
        description: 'Set or replace the target kubeconfig, stored as an encrypted Secret. Write-only: it is never returned.',
        security,
        params: targetParamsSchema,
        body: z.object({ kubeconfig: kubeconfigSchema.meta({ example: 'apiVersion: v1\nkind: Config\n...' }) }),
        response: {
          200: kubeconfigStatusSchema.describe('The kubeconfig Secret is stored.'),
          400: errorResponse('The kubeconfig is empty or too large.'),
          404: errorResponse('No target has that name.'),
          409: errorResponse('The target uses the in-cluster service account.'),
        },
      },
    },
    async (req) => ctx.executionTargets.setKubeconfig(req.params.name, req.body.kubeconfig),
  );

  app.delete(
    '/execution-targets/:name/kubeconfig',
    {
      schema: {
        tags,
        description: 'Clear the target kubeconfig Secret; clearing one that is not set succeeds.',
        security,
        params: targetParamsSchema,
        response: { 200: kubeconfigStatusSchema.describe('The kubeconfig Secret is not set.'), 404: errorResponse('No target has that name.') },
      },
    },
    async (req) => ctx.executionTargets.clearKubeconfig(req.params.name),
  );

  app.put(
    '/execution-targets/:name/credentials/:harness',
    {
      schema: {
        tags,
        description: 'Set or replace a Harness credential on the target, stored as an encrypted Secret. Write-only: it is never returned.',
        security,
        params: credentialParamsSchema,
        body: z.object({ value: credentialValueSchema.meta({ example: 'sk-ant-oat01-...' }) }),
        response: {
          200: credentialStatusSchema.describe('The credential Secret is stored.'),
          400: errorResponse('The value is empty or too large.'),
          404: errorResponse('No target has that name.'),
        },
      },
    },
    async (req) => ctx.executionTargets.setCredential(req.params.name, req.params.harness, req.body.value),
  );

  app.delete(
    '/execution-targets/:name/credentials/:harness',
    {
      schema: {
        tags,
        description: 'Clear a Harness credential Secret; clearing one that is not set succeeds.',
        security,
        params: credentialParamsSchema,
        response: { 200: credentialStatusSchema.describe('The credential Secret is not set.'), 404: errorResponse('No target has that name.') },
      },
    },
    async (req) => ctx.executionTargets.clearCredential(req.params.name, req.params.harness),
  );

  app.post(
    '/execution-targets/:name/rotate-proxy-key',
    {
      schema: {
        tags,
        description:
          'Replace the Repository Proxy signing key, which revokes every outstanding pass. Creates the key when none is set. The new key is returned once; copy it to the Repository Proxy, which rejects every pass until it has the new key.',
        security,
        params: targetParamsSchema,
        response: { 200: proxyKeyRotationSchema.describe('The new key, shown once.'), 404: errorResponse('No target has that name.'), 409: errorResponse('`local` is built in.') },
      },
    },
    async (req) => ctx.executionTargets.rotateProxyKey(req.params.name),
  );

  app.post(
    '/execution-targets/:name/check-proxy-key',
    {
      schema: {
        tags,
        description:
          'Check that the Repository Proxy accepts passes signed with the current key: Harmonic sends the proxy a probe pass for a repository that does not exist. `rejected` means the proxy is likely still on the old key. 409 when no signing key is set.',
        security,
        params: targetParamsSchema,
        response: {
          200: z.object({ outcome: z.enum(['agrees', 'rejected', 'unreachable']).meta({ example: 'agrees' }) }).meta({ id: 'ExecutionTargetProxyKeyCheck' }).describe('The proxy verdict.'),
          404: errorResponse('No target has that name.'),
          409: errorResponse('`local` is built in, or no signing key is set.'),
        },
      },
    },
    async (req) => ({ outcome: await ctx.executionTargets.checkProxyKey(req.params.name) }),
  );

  app.post(
    '/execution-targets/:name/test-connection',
    {
      schema: {
        tags,
        description: 'Test the saved target: list pods in its namespace with a 10 second timeout. Nothing is created.',
        security,
        params: targetParamsSchema,
        response: { 200: connectionResultSchema.describe('The outcome; a failure says what failed.'), 404: errorResponse('No target has that name.') },
      },
    },
    async (req) => ctx.executionTargets.testConnection(req.params.name),
  );

  app.get(
    '/workspaces/:id/execution-targets',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'Which Execution Targets this Workspace may use, which are effective, and why enabling one would be refused (no Code Repository, or `direct` Isolation Mode).',
        security,
        params: idParamsSchema,
        response: { 200: workspaceTargetsSchema.describe('Per-target availability for the Workspace.'), 404: errorResponse('No Workspace has that id.') },
      },
    },
    async (req) => describeWorkspaceTargets(await ctx.workspaces.get(req.params.id), ctx.executionTargets, ctx.settingsStore.getGlobal().defaults.isolationMode),
  );
}
