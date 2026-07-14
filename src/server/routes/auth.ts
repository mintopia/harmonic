import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { errorResponseSchema, okResponseSchema } from '../schemas.js';

export const SESSION_COOKIE = 'harmonic_session';

const loginBodySchema = z.object({
  password: z.string(),
  // Legacy operator configs may still send a username; password-only auth ignores it.
  username: z.string().optional(),
});

const meResponseSchema = z.object({
  authenticated: z.boolean(),
  passwordConfigured: z.boolean(),
});

const changePasswordBodySchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});

const createKeyBodySchema = z.object({ name: z.string().min(1) });

const keyIdParamsSchema = z.object({ id: z.coerce.number().int() });

/** An operator API key as listed/created — the bearer token itself is never included except right after creation. */
const keySchema = z.object({
  id: z.number(),
  name: z.string(),
  prefix: z.string(),
  scope: z.string(),
  runId: z.number().nullable(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
});

const keyWithTokenSchema = keySchema.extend({ token: z.string() });

const keysListResponseSchema = z.object({ keys: z.array(keySchema) });

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        description: 'Log in with the operator password, starting a session cookie.',
        body: loginBodySchema,
        response: {
          200: okResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { password } = req.body;
      if (!ctx.auth.verifyLogin(password)) {
        return reply.status(401).send({ error: { code: 'unauthenticated', message: 'wrong password' } });
      }
      const token = ctx.auth.createSession();
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
      });
      return { ok: true } as const;
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        description: 'End the current session.',
        response: { 200: okResponseSchema },
      },
    },
    async (req, reply) => {
      ctx.auth.destroySession(req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true } as const;
    },
  );

  app.get(
    '/auth/me',
    {
      schema: {
        tags: ['Auth'],
        description: 'Whether the caller has a valid session, and whether an operator password has been set.',
        response: { 200: meResponseSchema },
      },
    },
    async (req) => ({
      authenticated: ctx.auth.validateSession(req.cookies[SESSION_COOKIE]),
      passwordConfigured: ctx.auth.hasPassword(),
    }),
  );

  app.post(
    '/auth/change-password',
    {
      schema: {
        tags: ['Auth'],
        description:
          "Change the operator password. Verifies currentPassword first (a wrong current password changes nothing) and applies the same minimum-length rule as initial setup to newPassword. On success every session other than the caller's own is destroyed — a stolen cookie doesn't survive a credential rotation — but API Keys are untouched. Operator only; not reachable with a run-scoped Run Key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: changePasswordBodySchema,
        response: {
          200: okResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body;
      if (!ctx.auth.verifyLogin(currentPassword)) {
        return reply.status(401).send({ error: { code: 'unauthenticated', message: 'wrong current password' } });
      }
      ctx.auth.setPassword(newPassword);
      ctx.auth.destroyOtherSessions(req.cookies[SESSION_COOKIE]);
      return { ok: true } as const;
    },
  );

  app.post(
    '/keys',
    {
      schema: {
        tags: ['Keys'],
        description: 'Create a new operator API key. The bearer token is returned once and never stored.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: createKeyBodySchema,
        response: { 201: keyWithTokenSchema },
      },
    },
    async (req, reply) => {
      const { key, token } = ctx.auth.createKey(req.body.name);
      const { tokenHash: _hash, ...rest } = key;
      return reply.status(201).send({ ...rest, token });
    },
  );

  app.get(
    '/keys',
    {
      schema: {
        tags: ['Keys'],
        description: 'List operator API keys (Run Keys are internal and never listed).',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: { 200: keysListResponseSchema },
      },
    },
    async () => ({ keys: ctx.auth.listKeys() }),
  );

  app.delete(
    '/keys/:id',
    {
      schema: {
        tags: ['Keys'],
        description: 'Revoke an operator API key immediately.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: keyIdParamsSchema,
        response: { 200: okResponseSchema },
      },
    },
    async (req) => {
      ctx.auth.revokeKey(req.params.id);
      return { ok: true } as const;
    },
  );
}
