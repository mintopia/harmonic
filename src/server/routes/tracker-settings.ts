import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TrackingContext } from '../app.js';
import { idParamsSchema, errorResponse } from '../schemas.js';
import { declaredTrackerName } from '../../tracker/adapter.js';
import { normaliseKindId, trackerKindFor, TRACKER_KINDS } from '../../tracker/kinds.js';
import { resolveCodeRepository } from '../../repository/resolve.js';
import { safeErrorReason } from '../../tracker/rest-client.js';

const verifyResponseSchema = z
  .union([z.object({ ok: z.literal(true), identity: z.string().meta({ example: 'octocat' }) }), z.object({ ok: z.literal(false), reason: z.string() })])
  .meta({ id: 'TrackerVerifyResult', description: 'The authenticated identity (or, for a Code Repository, its kind) on success, else why verification failed. Never contains a Secret value.' });

const trackerKindSchema = z
  .object({
    id: z.string().meta({ example: 'github' }),
    label: z.string().meta({ example: 'GitHub' }),
    secretNames: z.array(z.string()),
    settingsSchema: z.record(z.string(), z.unknown()).describe('JSON Schema of the kind settings.'),
    capabilities: z.object({
      close: z.boolean(),
      reopen: z.boolean(),
      claim: z.boolean(),
      transition: z.boolean(),
      epicSources: z.array(z.string()),
    }),
  })
  .meta({ id: 'TrackerKind' });

const detectionSchema = z
  .object({
    detectedTracker: z.object({ name: z.string(), kind: z.string().nullable() }).nullable(),
    detectedCodeRepository: z.enum(['github', 'gitlab', 'forgejo']).nullable(),
  })
  .meta({ id: 'TrackerDetection' });

const failure = (err: unknown) => ({ ok: false as const, reason: safeErrorReason(err) });

export async function trackerSettingsRoutes(fastify: FastifyInstance, ctx: Pick<TrackingContext, 'workspaces' | 'trackerManager'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];

  app.get(
    '/tracker-kinds',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'The tracker kinds Harmonic can talk to, with their settings JSON Schema and Secret names.',
        security,
        response: { 200: z.object({ kinds: z.array(trackerKindSchema) }).describe('Every registered tracker kind.') },
      },
    },
    async () => ({
      kinds: TRACKER_KINDS.map((kind) => ({
        id: kind.id,
        label: kind.label,
        secretNames: [...kind.secretNames],
        settingsSchema: z.toJSONSchema(kind.settings, { unrepresentable: 'any' }) as Record<string, unknown>,
        capabilities: { ...kind.capabilities, epicSources: [...kind.capabilities.epicSources] },
      })),
    }),
  );

  app.get(
    '/workspaces/:id/tracker-detection',
    {
      schema: {
        tags: ['Workspaces'],
        description: 'The Detected Tracker declared by the repo and the Code Repository detected from its origin remote.',
        security,
        params: idParamsSchema,
        response: { 200: detectionSchema.describe('What was detected from the repo; either may be null.'), 404: errorResponse('No Workspace has that id.') },
      },
    },
    async (req) => {
      const ws = await ctx.workspaces.get(req.params.id);
      const doc = await readFile(join(ws.workingDir, 'docs/agents/issue-tracker.md'), 'utf8').catch(() => null);
      const name = doc ? declaredTrackerName(doc) : undefined;
      const kindId = name ? normaliseKindId(name) : null;
      return {
        detectedTracker: name ? { name, kind: kindId && trackerKindFor(kindId) ? kindId : null } : null,
        detectedCodeRepository: await resolveCodeRepository(ws.workingDir),
      };
    },
  );

  app.post(
    '/workspaces/:id/tracker/verify',
    {
      schema: {
        tags: ['Workspaces'],
        description: "Verify the Workspace's Resolved Tracker is reachable and report the identity it acts as.",
        security,
        params: idParamsSchema,
        response: { 200: verifyResponseSchema.describe('The verification outcome; a failure is still a 200 with ok false.'), 404: errorResponse('No Workspace has that id.') },
      },
    },
    async (req) => {
      const ws = await ctx.workspaces.get(req.params.id);
      try {
        const adapter = await ctx.trackerManager.adapterFor(ws);
        if (!adapter.identify) return { ok: false as const, reason: `${adapter.name} cannot report an identity` };
        return { ok: true as const, identity: await adapter.identify() };
      } catch (err) {
        return failure(err);
      }
    },
  );

  app.post(
    '/workspaces/:id/repository/verify',
    {
      schema: {
        tags: ['Workspaces'],
        description: "Verify the Workspace's Code Repository is reachable with the ambient credentials.",
        security,
        params: idParamsSchema,
        response: { 200: verifyResponseSchema.describe('The verification outcome; a failure is still a 200 with ok false.'), 404: errorResponse('No Workspace has that id.') },
      },
    },
    async (req) => {
      const ws = await ctx.workspaces.get(req.params.id);
      try {
        const adapter = await ctx.trackerManager.repositoryFor(ws);
        if (!adapter) return { ok: false as const, reason: 'No Code Repository adapter for this Workspace' };
        const result = await adapter.verify();
        return result.ok ? { ok: true as const, identity: adapter.kind } : result;
      } catch (err) {
        return failure(err);
      }
    },
  );
}
