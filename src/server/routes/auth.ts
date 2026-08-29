import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { errorResponse, okResponseSchema } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

export const SESSION_COOKIE = 'harmonic_session';

/**
 * Examples on this file's schemas follow schemas.ts's convention, with one
 * exception: no field that carries a credential gets a plausible-looking
 * value. Passwords and the once-returned key token use angle-bracket
 * placeholders instead, so nothing in the published spec can be mistaken for
 * a working secret or copied out of the docs page as one.
 */

const loginBodySchema = z.object({
  password: z.string().meta({ example: '<your-operator-password>' }),
});

const meResponseSchema = z.object({
  authenticated: z.boolean().meta({ example: true }),
  passwordConfigured: z.boolean().meta({ example: true }),
});

const changePasswordBodySchema = z.object({
  currentPassword: z.string().meta({ example: '<your-current-password>' }),
  newPassword: z.string().min(4).meta({ example: '<your-new-password>' }),
});

const removePasswordBodySchema = z.object({
  currentPassword: z.string().meta({ example: '<your-current-password>' }),
});

const createKeyBodySchema = z.object({
  name: z.string().min(1).meta({ example: 'ci-pipeline' }),
  /** 'full' (default) drives the whole fleet; 'read' is a viz-client key — GET tasks/attempts/maps + WS, no mutations (issue #35). */
  scope: z.enum(['full', 'read']).optional().meta({ example: 'read' }),
});

const keyIdParamsSchema = z.object({ id: z.coerce.number().int().meta({ example: 12 }) });

/** An operator API key as listed/created — the bearer token itself is never included except right after creation. */
const keySchema = z.object({
  id: z.number().meta({ example: 12 }),
  name: z.string().meta({ example: 'ci-pipeline' }),
  /** First characters of the token, for display — too short to authenticate with. */
  prefix: z.string().meta({ example: 'adk_1f3c9e02' }),
  /** 'full' or 'read' (issue #35); 'attempt'/'conversation' keys are internal and never listed. */
  scope: z.string().meta({ example: 'full' }),
  /** Set only on attempt-scoped keys, so null on every key this API returns. */
  attemptId: z.number().nullable().meta({ example: null }),
  createdAt: z.number().meta({ example: 1784030400000 }),
  /** Touched on each successful bearer auth; null until first use, as on a key this moment created. */
  lastUsedAt: z.number().nullable().meta({ example: null }),
  revokedAt: z.number().nullable().meta({ example: null }),
});

/** The creation-only shape: `token` is the bearer token, returned here and never again. */
const keyWithTokenSchema = keySchema.extend({
  token: z.string().meta({ example: '<the-new-key-token, shown only in this response>' }),
});

const keysListResponseSchema = listResponse('keys', keySchema);

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
          200: okResponseSchema.describe('The password matched; a session cookie is set on this response.'),
          401: errorResponse('The password did not match, or no operator password has been set yet.'),
        },
      },
    },
    async (req, reply) => {
      const { password } = req.body;
      if (!(await ctx.auth.verifyLogin(password))) {
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
        response: {
          200: okResponseSchema.describe(
            'The cookie is cleared and its session destroyed; sent the same way when there was no session to end.',
          ),
        },
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
        response: {
          200: meResponseSchema.describe(
            "Whether this request's cookie names a live session, and whether an operator password is configured at all.",
          ),
        },
      },
    },
    async (req) => ({
      authenticated: ctx.auth.validateSession(req.cookies[SESSION_COOKIE]),
      passwordConfigured: await ctx.auth.hasPassword(),
    }),
  );

  app.post(
    '/auth/change-password',
    {
      schema: {
        tags: ['Auth'],
        description:
          "Set or change the operator password. When one is already set, currentPassword must match (a wrong current password changes nothing); when none is set (ungated), currentPassword is ignored and this sets the initial password. newPassword takes the same minimum-length rule as initial setup. On success every session other than the caller's own is destroyed — a stolen cookie doesn't survive a credential rotation — but API Keys are untouched. Operator only; not reachable with an attempt-scoped Attempt Key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: changePasswordBodySchema,
        response: {
          200: okResponseSchema.describe(
            "The password was changed; every session other than the caller's own is now destroyed, and API Keys are untouched.",
          ),
          400: errorResponse(
            'newPassword is shorter than the four-character minimum, or the payload was otherwise invalid — nothing was changed.',
          ),
          401: errorResponse(
            'The request carried no valid session or key, or currentPassword did not match — nothing was changed.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body;
      if ((await ctx.auth.hasPassword()) && !(await ctx.auth.verifyLogin(currentPassword))) {
        return reply.status(401).send({ error: { code: 'unauthenticated', message: 'wrong current password' } });
      }
      await ctx.auth.setPassword(newPassword);
      ctx.auth.destroyOtherSessions(req.cookies[SESSION_COOKIE]);
      return { ok: true } as const;
    },
  );

  app.delete(
    '/auth/password',
    {
      schema: {
        tags: ['Auth'],
        description:
          'Remove the operator password — Harmonic falls back to ungated (every API surface open). Verifies currentPassword first when one is set; a no-op when none is set (idempotent). On success every session other than the caller\'s own is destroyed. Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: removePasswordBodySchema,
        response: {
          200: okResponseSchema.describe('The password is removed (or was already unset); Harmonic is now ungated.'),
          401: errorResponse('A password is set and currentPassword did not match — nothing was changed.'),
        },
      },
    },
    async (req, reply) => {
      if (await ctx.auth.hasPassword()) {
        if (!(await ctx.auth.verifyLogin(req.body.currentPassword))) {
          return reply.status(401).send({ error: { code: 'unauthenticated', message: 'wrong current password' } });
        }
        await ctx.auth.clearPassword();
        ctx.auth.destroyOtherSessions(req.cookies[SESSION_COOKIE]);
      }
      return { ok: true } as const;
    },
  );

  app.post(
    '/keys',
    {
      schema: {
        tags: ['Keys'],
        description:
          "Create a new operator API key. `scope` defaults to 'full' (drives the whole fleet); 'read' mints a viz-client key that can GET tasks/attempts/maps and open the WebSocket but cannot mutate anything. The bearer token is returned once and never stored.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: createKeyBodySchema,
        response: {
          201: keyWithTokenSchema.describe(
            'The created key, with its bearer token in `token` — the only response that ever carries it.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { key, token } = await ctx.auth.createKey(req.body.name, req.body.scope ? { scope: req.body.scope } : {});
      const { tokenHash: _hash, ...rest } = key;
      return reply.status(201).send({ ...rest, token });
    },
  );

  app.get(
    '/keys',
    {
      schema: {
        tags: ['Keys'],
        description: 'List operator API keys (Attempt Keys are internal and never listed).',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: paginationQuerySchema,
        response: {
          200: keysListResponseSchema.describe(
            'Every full-scope operator key, revoked ones included, newest first; no token values.',
          ),
        },
      },
    },
    async (req) => {
      const { limit, offset } = req.query;
      const { items, total } = paginate(await ctx.auth.listKeys(), { limit, offset });
      return { keys: items, total };
    },
  );

  app.delete(
    '/keys/:id',
    {
      schema: {
        tags: ['Keys'],
        description: 'Revoke an operator API key immediately.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: keyIdParamsSchema,
        response: {
          200: okResponseSchema.describe(
            'The key can no longer authenticate; re-revoking an already-revoked key keeps its original revokedAt.',
          ),
        },
      },
    },
    async (req) => {
      await ctx.auth.revokeKey(req.params.id);
      return { ok: true } as const;
    },
  );
}
