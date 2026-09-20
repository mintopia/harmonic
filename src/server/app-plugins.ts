import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { readPackageManifest } from './routes/openapi.js';
import { SESSION_COOKIE } from './routes/auth.js';
import { buildSpecDescription } from './openapi-description.js';
import type { App } from './app-context.js';

export async function registerPlugins(app: App): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Fastify's default JSON parser throws FST_ERR_CTP_EMPTY_JSON_BODY on an empty body; optional-body POSTs send exactly that.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  const pkg = readPackageManifest();
  const specDescription = buildSpecDescription(pkg);
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: pkg.name, version: pkg.version, description: specDescription },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'A key created via POST /api/keys, sent as `Authorization: Bearer <token>`.',
          },
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: SESSION_COOKIE,
            description: 'The session cookie set by POST /api/auth/login.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    // Without transformObject, fastify-type-provider-zod emits `$ref`s for `.meta({ id })` schemas but never writes them into components.schemas.
    transformObject: jsonSchemaTransformObject,
  });
}
