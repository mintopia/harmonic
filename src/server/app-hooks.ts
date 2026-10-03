import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { DomainError } from '../domain/errors.js';
import { errorMessage } from '../error-handling.js';
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
    const clientStatus = clientErrorStatus(err);
    if (clientStatus !== undefined) {
      return reply.status(clientStatus).send({ error: { code: 'bad_request', message: errorMessage(err) } });
    }
    const errorId = logServerError(req, 500, err);
    return reply.status(500).send({ error: { code: 'internal', message: 'internal server error', id: errorId } });
  });
}

const loggedRequests = new WeakSet<FastifyRequest>();

function clientErrorStatus(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

function logServerError(req: FastifyRequest, status: number, err: unknown): string {
  loggedRequests.add(req);
  const errorId = String(req.id);
  const cause = err instanceof Error ? err : undefined;
  const route = req.routeOptions.url ?? req.url;
  const detail = cause?.message ?? (err === undefined ? `status ${status} sent by handler` : String(err));
  logger.error(`unhandled error serving ${req.method} ${route}: ${detail}`, {
    errorId,
    method: req.method,
    route,
    url: req.url,
    status,
    error: detail,
    ...(cause?.stack ? { stack: cause.stack } : {}),
    ...(cause?.cause !== undefined ? { cause: errorMessage(cause.cause) } : {}),
  });
  return errorId;
}

export function registerServerErrorLogging(app: App): void {
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode < 500 || loggedRequests.has(req)) return;
    logServerError(req, reply.statusCode, undefined);
  });
}

export function fastifyLogger(bindings: Record<string, unknown> = {}): FastifyBaseLogger {
  const forward = (level: 'error' | 'warn') => (first: unknown, second?: unknown): void => {
    const attributes = { ...bindings, ...(typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {}) };
    const text = typeof first === 'string' ? first : typeof second === 'string' ? second : 'fastify';
    const err = attributes.err ?? attributes.error;
    if (err === undefined) {
      logger[level](`fastify: ${text}`);
      return;
    }
    const cause = err instanceof Error ? err : undefined;
    logger.error(`fastify: ${text}: ${cause?.message ?? String(err)}`, {
      ...(typeof attributes.reqId === 'string' ? { errorId: attributes.reqId } : {}),
      ...(cause?.stack ? { stack: cause.stack } : {}),
      ...(cause?.cause !== undefined ? { cause: errorMessage(cause.cause) } : {}),
    });
  };
  const instance: FastifyBaseLogger = {
    level: 'warn',
    fatal: forward('error'),
    error: forward('error'),
    warn: forward('warn'),
    info: () => {},
    debug: () => {},
    trace: () => {},
    silent: () => {},
    child: (childBindings) => fastifyLogger({ ...bindings, ...childBindings }),
  };
  return instance;
}
