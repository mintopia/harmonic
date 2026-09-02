import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { HARNESS_IDS } from '../../config.js';
import { CONVERSATION_STATES } from '../../db/schema.js';
import { resolveScoped } from '../../domain/setting-override.js';
import { DomainError } from '../../domain/errors.js';
import { conversationToApi } from '../serialize.js';
import { costSchema, errorResponse, idParamsSchema, okResponseSchema, attemptUsageSchema } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const createConversationInputSchema = z.object({
  /** The owning Workspace; defaults to the earliest-created Workspace when omitted. */
  workspaceId: z.number().int().positive().optional().meta({ example: 1 }),
  harness: z.enum(HARNESS_IDS).optional().meta({ example: 'claude' }),
  model: z.string().min(1).optional().meta({ example: 'sonnet-5' }),
  workingDir: z.string().min(1).optional().meta({ example: '/home/dev/harmonic' }),
});

/** Rename a Conversation; null clears the custom title, falling back to the derived one. */
const updateConversationInputSchema = z.object({
  title: z.string().nullable().meta({ example: 'Rate limiting for the tasks API' }),
});

const turnInputSchema = z.object({
  text: z.string().min(1).meta({ example: 'Why does the rate limiter drop the first request after a restart?' }),
});
const turnResponseSchema = z.object({
  ok: z.literal(true).meta({ example: true }),
  /** True when a Turn was already running and this message was queued as the next Turn. */
  queued: z.boolean().meta({ example: false }),
});
const interruptInputSchema = z
  .object({ text: z.string().optional().meta({ example: 'Stop — check the existing tests first.' }) })
  .nullish();

const permissionParamsSchema = z.object({
  id: z.coerce.number().int().meta({ example: 7402 }),
  /** The `perm-{n}` id the Harness's held request was announced under. */
  reqId: z.string().min(1).meta({ example: 'perm-3' }),
});
const answerPermissionInputSchema = z.object({
  optionId: z.string().min(1).meta({ example: 'allow_once' }),
  /** "Always allow in {dir}" — persist a Permission Rule for this tool kind + Working Directory. */
  remember: z.boolean().optional().meta({ example: false }),
});

/** A Conversation as the API serves it (serialize.ts `ApiConversation`). */
const conversationSchema = z
  .object({
    id: z.number().meta({ example: 7402 }),
    /** Operator-set title; null falls back to a title derived from the first Turn. */
    title: z.string().nullable().meta({ example: 'Rate limiting for the tasks API' }),
    workspaceId: z.number().meta({ example: 1 }),
    /** One of config.ts's HARNESS_IDS; stored as plain text. */
    harness: z.string().meta({ example: 'claude' }),
    model: z.string().meta({ example: 'sonnet-5' }),
    workingDir: z.string().meta({ example: '/home/dev/harmonic' }),
    state: z.enum(CONVERSATION_STATES).meta({ example: 'active' }),
    /** The warm ACP session id, set once the harness spawns; null before the first Turn. */
    sessionId: z.string().nullable().meta({ example: 'b7e4d2a1-6c93-4f18-8a52-1d0f3b9e7c46' }),
    /** Running Usage accumulated across Turns; null before any usage. */
    usage: attemptUsageSchema.nullable(),
    /** Cost of the running Usage; honest-incomplete for unpriced models. */
    cost: costSchema.nullable(),
    /** The latest Turn's input-side token footprint (context fill); null when unknown. */
    contextTokens: z.number().nullable().meta({ example: 46200 }),
    /** The model's configured context window; null when unconfigured (percentage suppressed). */
    contextWindow: z.number().nullable().meta({ example: 200000 }),
    /** The harness cache's warm duration in seconds. */
    cacheWarmSeconds: z.number().nullable().meta({ example: 300 }),
    createdAt: z.number().meta({ example: 1784030400000 }),
    updatedAt: z.number().meta({ example: 1784032260000 }),
    /** Set when the Conversation ends; null while active. */
    endedAt: z.number().nullable().meta({ example: null }),
  })
  .meta({ id: 'Conversation' });

const conversationsListResponseSchema = listResponse('conversations', conversationSchema);
const conversationsListQuerySchema = z.object({
  /** Scope to one Workspace's Conversations; omitted means every Workspace. */
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 1 }),
});

const conversationEventSchema = z.object({
  id: z.number().meta({ example: 88104 }),
  conversationId: z.number().meta({ example: 7402 }),
  seq: z.number().meta({ example: 17 }),
  ts: z.number().meta({ example: 1784032140000 }),
  /** 'session_update' | 'permission_request' | 'lifecycle' | 'user_turn' */
  type: z.string().meta({ example: 'user_turn' }),
  /** For session_update, the ACP `update` object verbatim — shape varies by update kind; for user_turn, `{ text }`. */
  payload: z.unknown().meta({
    example: { text: 'Why does the rate limiter drop the first request after a restart?' },
  }),
});

const eventsListResponseSchema = listResponse('events', conversationEventSchema);

export async function conversationRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/conversations',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Create a Conversation (an interactive, multi-turn exchange the operator drives with a Harness over ACP). Execution settings default from global config. Operator only; not reachable with an attempt-scoped key. The harness spawns on the first Turn, not here.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: createConversationInputSchema,
        response: {
          201: conversationSchema.describe('The created Conversation, active and awaiting its first Turn.'),
          400: errorResponse(
            'The payload failed validation, or the requested harness is not configured on this server.',
          ),
        },
      },
    },
    async (req, reply) => {
      const config = ctx.settingsStore.getGlobal();
      const workspace = await ctx.workspaces.resolve(req.body.workspaceId);
      const harness = req.body.harness ?? resolveScoped('chatHarness', workspace.chatHarness, config.chat.harness);
      const harnessConfig = config.harnesses[harness as keyof typeof config.harnesses];
      if (!harnessConfig) throw new DomainError('validation', `harness '${harness}' is not configured`);
      const conversation = await ctx.conversations.create({
        workspaceId: workspace.id,
        harness,
        model: req.body.model ?? resolveScoped('chatModel', workspace.chatModel, config.chat.model),
        workingDir: req.body.workingDir ?? workspace.workingDir,
      });
      return reply.status(201).send(await conversationToApi(ctx, conversation));
    },
  );

  app.get(
    '/conversations',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'List Conversations, newest first, optionally scoped to one Workspace. Operator only; not reachable with an attempt-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: conversationsListQuerySchema.extend(paginationQuerySchema.shape),
        response: {
          200: conversationsListResponseSchema.describe('Every matching Conversation, active and ended alike, newest first.'),
        },
      },
    },
    async (req) => {
      const { workspaceId, limit, offset } = req.query;
      const conversations = await Promise.all(
        (await ctx.conversations.list(workspaceId)).map((c) => conversationToApi(ctx, c)),
      );
      const { items, total } = paginate(conversations, { limit, offset });
      return { conversations: items, total };
    },
  );

  app.get(
    '/conversations/:id',
    {
      schema: {
        tags: ['Conversations'],
        description: 'Get one Conversation. Operator only; not reachable with an attempt-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: conversationSchema.describe('The Conversation, with its telemetry.'),
          404: errorResponse('No Conversation has that id.'),
        },
      },
    },
    async (req) => conversationToApi(ctx, await ctx.conversations.get(req.params.id)),
  );

  app.patch(
    '/conversations/:id',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Rename a Conversation; pass title null to clear it and fall back to the title derived from the first Turn. Operator only; not reachable with an attempt-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: updateConversationInputSchema,
        response: {
          200: conversationSchema.describe('The renamed Conversation, carrying its new or derived title.'),
          400: errorResponse('The payload failed validation — see the error message for the offending field.'),
          404: errorResponse('No Conversation has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.conversations.assertExists(req.params.id);
      return conversationToApi(ctx, await ctx.conversations.update(req.params.id, { title: req.body.title }));
    },
  );

  app.delete(
    '/conversations/:id',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Delete a Conversation: stops the harness if warm, revokes its key, and cascades its events. Operator only; not reachable with an attempt-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: okResponseSchema.describe('The Conversation, its key, and its events are gone.'),
          404: errorResponse('No Conversation has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.conversations.assertExists(req.params.id);
      await ctx.conversationDriver.end(req.params.id);
      await ctx.auth.deleteKeysForConversation(req.params.id);
      await ctx.conversations.delete(req.params.id);
      return { ok: true } as const;
    },
  );

  app.get(
    '/conversations/:id/events',
    {
      schema: {
        tags: ['Conversations'],
        description:
          "Replay a Conversation's persisted events, in order — the same records streamed live over the WebSocket. Operator only; not reachable with an attempt-scoped key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: eventsListResponseSchema.describe("The Conversation's persisted events in sequence order."),
          404: errorResponse('No Conversation has that id.'),
        },
      },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const { items, total } = paginate(await ctx.conversations.listEvents(req.params.id), { limit, offset });
      return { events: items, total };
    },
  );

  app.post(
    '/conversations/:id/turns',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Send an operator Turn. Spawns the harness on the first Turn and keeps it warm across Turns; the reply streams over the WebSocket. If a Turn is already running, the message is queued and sent as the next Turn (issue 14). Operator only; not reachable with an attempt-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: turnInputSchema,
        response: {
          200: turnResponseSchema.describe('The Turn was accepted; `queued` says whether it went behind a running one.'),
          400: errorResponse(
            'The payload failed validation, or the harness could not be spawned — its Working Directory does not exist, or its harness is not configured.',
          ),
          404: errorResponse('No Conversation has that id.'),
          409: errorResponse('The Conversation has ended, so it can take no further Turns.'),
        },
      },
    },
    async (req) => {
      const { queued } = await ctx.conversationDriver.submitTurn(req.params.id, req.body.text);
      return { ok: true as const, queued };
    },
  );

  app.post(
    '/conversations/:id/interrupt',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Steer a running Turn (issue 14): cancel the in-flight Turn via ACP session/cancel and re-prompt with `text` as the next Turn, or just stop it when `text` is empty. The cancelled Turn records a cancelled stop reason. Operator only; not reachable with an attempt-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: interruptInputSchema,
        response: {
          200: okResponseSchema.describe('The in-flight Turn was cancelled, and any steering text queued as the next.'),
          400: errorResponse(
            'The payload failed validation, or steering an idle Conversation could not spawn the harness — its Working Directory does not exist, or its harness is not configured.',
          ),
          404: errorResponse('No Conversation has that id.'),
          409: errorResponse('The Conversation has ended, so it has no Turn to steer.'),
        },
      },
    },
    async (req) => {
      await ctx.conversationDriver.interrupt(req.params.id, req.body?.text);
      return { ok: true } as const;
    },
  );

  app.post(
    '/conversations/:id/permissions/:reqId',
    {
      schema: {
        tags: ['Conversations'],
        description:
          "Answer a Harness's held permission request in a Conversation (ADR-0007). `optionId` is the ACP option the operator chose — allow_once, the native allow_always ('Allow for this conversation'), or a reject option. Set `remember` to also persist a Permission Rule ('Always allow in {dir}') keyed on the tool kind + Working Directory. Operator only; not reachable with an attempt-scoped key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: permissionParamsSchema,
        body: answerPermissionInputSchema,
        response: {
          200: okResponseSchema.describe('The answer was handed to the Harness and the held request released.'),
          404: errorResponse('No permission request with that reqId is pending for this Conversation.'),
        },
      },
    },
    async (req) => {
      await ctx.conversationDriver.answerPermission(req.params.id, req.params.reqId, req.body.optionId, req.body.remember);
      return { ok: true } as const;
    },
  );

  app.post(
    '/conversations/:id/end',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'End a Conversation: stop the harness and mark it ended (its transcript survives read-only; it cannot resume). Operator only; not reachable with an attempt-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: {
          200: conversationSchema.describe('The Conversation in its ended state; already-ended is a no-op.'),
          404: errorResponse('No Conversation has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.conversations.assertExists(req.params.id);
      return conversationToApi(ctx, await ctx.conversationDriver.end(req.params.id));
    },
  );
}
