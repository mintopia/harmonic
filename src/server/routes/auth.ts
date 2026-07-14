import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';

export const SESSION_COOKIE = 'agentdeck_session';

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;

  fastify.post('/auth/login', async (req, reply) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    if (!ctx.auth.verifyPassword(password)) {
      return reply.status(401).send({ error: { code: 'unauthenticated', message: 'wrong password' } });
    }
    const token = ctx.auth.createSession();
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
    });
    return { ok: true };
  });

  fastify.post('/auth/logout', async (req, reply) => {
    ctx.auth.destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  fastify.get('/auth/me', async (req) => ({
    authenticated: ctx.auth.validateSession(req.cookies[SESSION_COOKIE]),
    passwordConfigured: ctx.auth.hasPassword(),
  }));

  fastify.post('/keys', async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const { key, token } = ctx.auth.createKey(name);
    // The token is returned exactly once; only its hash is stored.
    return reply.status(201).send({ ...key, tokenHash: undefined, token });
  });

  fastify.get('/keys', async () => ({ keys: ctx.auth.listKeys() }));

  fastify.delete('/keys/:id', async (req) => {
    ctx.auth.revokeKey(Number((req.params as { id: string }).id));
    return { ok: true };
  });
}
