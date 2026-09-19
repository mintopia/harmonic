import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { DomainError } from '../domain/errors.js';
import type { App, RegisteredRoute } from './app-context.js';

export function registerRouteRecorder(app: App, registeredRoutes: RegisteredRoute[]): void {
  app.addHook('onRoute', (opts) => {
    for (const method of Array.isArray(opts.method) ? opts.method : [opts.method]) {
      registeredRoutes.push({ method, url: opts.url });
    }
  });
}

export function registerErrorHandler(app: App): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'validation',
          message: err.validation
            .map((i) => `${i.instancePath.slice(1).replace(/\//g, '.')}: ${i.message}`)
            .join('; '),
        },
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      });
    }
    const cause = err instanceof Error ? err : undefined;
    logger.error(`unhandled error serving ${req.method} ${req.url}: ${cause?.message ?? String(err)}`, {
      method: req.method,
      url: req.url,
      error: cause?.message ?? String(err),
      ...(cause?.stack ? { stack: cause.stack } : {}),
    });
    return reply.status(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });
}
