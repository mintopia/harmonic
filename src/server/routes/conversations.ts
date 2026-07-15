import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { HARNESS_IDS } from '../../config.js';
import { CONVERSATION_STATES } from '../../db/schema.js';
import { DomainError } from '../../domain/errors.js';
import { conversationToApi } from '../serialize.js';
import { costSchema, errorResponseSchema, idParamsSchema, okResponseSchema, runUsageSchema } from '../schemas.js';

const createConversationInputSchema = z.object({
  harness: z.enum(HARNESS_IDS).optional(),
  model: z.string().min(1).optional(),
  workingDir: z.string().min(1).optional(),
});

const turnInputSchema = z.object({ text: z.string().min(1) });

const permissionParamsSchema = z.object({ id: z.coerce.number().int(), reqId: z.string().min(1) });
const answerPermissionInputSchema = z.object({
  optionId: z.string().min(1),
  /** "Always allow in {dir}" — persist a Permission Rule for this tool kind + Working Directory (ADR-0007). */
  remember: z.boolean().optional(),
});

/** A Conversation as the API serves it (serialize.ts `ApiConversation`). */
const conversationSchema = z
  .object({
    id: z.number(),
    /** Operator-set title; null falls back to a title derived from the first Turn (issue 15). */
    title: z.string().nullable(),
    /** One of config.ts's HARNESS_IDS; stored as plain text. */
    harness: z.string(),
    model: z.string(),
    workingDir: z.string(),
    state: z.enum(CONVERSATION_STATES),
    /** The warm ACP session id, set once the harness spawns; null before the first Turn. */
    sessionId: z.string().nullable(),
    /** Running Usage accumulated across Turns (issue 12); null before any usage. */
    usage: runUsageSchema.nullable(),
    /** Cost of the running Usage; honest-incomplete for unpriced models. */
    cost: costSchema.nullable(),
    /** The latest Turn's input-side token footprint (context fill); null when unknown. */
    contextTokens: z.number().nullable(),
    /** The model's configured context window; null when unconfigured (percentage suppressed). */
    contextWindow: z.number().nullable(),
    /** The model's configured cache TTL in seconds; null when unconfigured (cold-cache banner suppressed). */
    cacheTtlSeconds: z.number().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    endedAt: z.number().nullable(),
  })
  .meta({ id: 'Conversation' });

const conversationsListResponseSchema = z.object({ conversations: z.array(conversationSchema) });

const conversationEventSchema = z.object({
  id: z.number(),
  conversationId: z.number(),
  seq: z.number(),
  ts: z.number(),
  /** 'session_update' | 'permission_request' | 'lifecycle' | 'user_turn' */
  type: z.string(),
  /** For session_update, the ACP `update` object verbatim; for user_turn, `{ text }`. */
  payload: z.unknown(),
});

const eventsListResponseSchema = z.object({ events: z.array(conversationEventSchema) });

export async function conversationRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/conversations',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Create a Conversation (an interactive multi-turn chat with a Harness). Execution settings default from global config. Operator only; not reachable with a run-scoped key. The harness spawns on the first Turn, not here.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: createConversationInputSchema,
        response: { 201: conversationSchema, 400: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const config = ctx.configStore.get();
      const harness = req.body.harness ?? config.defaults.harness;
      const harnessConfig = config.harnesses[harness];
      if (!harnessConfig) throw new DomainError('validation', `harness '${harness}' is not configured`);
      const conversation = ctx.conversations.create({
        harness,
        model: req.body.model ?? harnessConfig.defaultModel,
        workingDir: req.body.workingDir ?? config.defaults.workingDir,
      });
      return reply.status(201).send(conversationToApi(ctx, conversation));
    },
  );

  app.get(
    '/conversations',
    {
      schema: {
        tags: ['Conversations'],
        description: 'List Conversations, newest first. Operator only; not reachable with a run-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: conversationsListResponseSchema },
      },
    },
    async () => ({ conversations: ctx.conversations.list().map((c) => conversationToApi(ctx, c)) }),
  );

  app.get(
    '/conversations/:id',
    {
      schema: {
        tags: ['Conversations'],
        description: 'Get one Conversation. Operator only; not reachable with a run-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: { 200: conversationSchema, 404: errorResponseSchema },
      },
    },
    async (req) => conversationToApi(ctx, ctx.conversations.get(req.params.id)),
  );

  app.get(
    '/conversations/:id/events',
    {
      schema: {
        tags: ['Conversations'],
        description:
          "Replay a Conversation's persisted events, in order — the same records streamed live over the WebSocket. Operator only; not reachable with a run-scoped key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: { 200: eventsListResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => ({ events: ctx.conversations.listEvents(req.params.id) }),
  );

  app.post(
    '/conversations/:id/turns',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'Send an operator Turn. Spawns the harness on the first Turn and keeps it warm across Turns; the reply streams over the WebSocket. Operator only; not reachable with a run-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        body: turnInputSchema,
        response: { 200: okResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (req) => {
      await ctx.conversationDriver.submitTurn(req.params.id, req.body.text);
      return { ok: true } as const;
    },
  );

  app.post(
    '/conversations/:id/permissions/:reqId',
    {
      schema: {
        tags: ['Conversations'],
        description:
          "Answer a Harness's held permission request in a Conversation (ADR-0007). `optionId` is the ACP option the operator chose — allow_once, the native allow_always ('Allow for this conversation'), or a reject option. Set `remember` to also persist a Permission Rule ('Always allow in {dir}') keyed on the tool kind + Working Directory. Operator only; not reachable with a run-scoped key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: permissionParamsSchema,
        body: answerPermissionInputSchema,
        response: { 200: okResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      ctx.conversationDriver.answerPermission(req.params.id, req.params.reqId, req.body.optionId, req.body.remember);
      return { ok: true } as const;
    },
  );

  app.post(
    '/conversations/:id/end',
    {
      schema: {
        tags: ['Conversations'],
        description:
          'End a Conversation: stop the harness and mark it ended (its transcript survives read-only; it cannot resume). Operator only; not reachable with a run-scoped key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: idParamsSchema,
        response: { 200: conversationSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      ctx.conversations.get(req.params.id); // 404 on unknown
      return conversationToApi(ctx, ctx.conversationDriver.end(req.params.id));
    },
  );
}
