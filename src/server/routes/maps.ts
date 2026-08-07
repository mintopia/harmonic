import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse } from '../schemas.js';

/**
 * A derived Map (D7, issue #35): a `wayfinder:map` issue paired with the
 * mirrored Tasks that share its mapRef, plus per-state counts. Not stored —
 * a query-time rollup over the last poll's scan (see TrackerPoller.maps).
 */
const mapSchema = z
  .object({
    ref: z.number().meta({ example: 19 }),
    title: z.string().meta({ example: 'Wayfinder' }),
    url: z.string().meta({ example: 'https://github.com/mintopia/harmonic/issues/19' }),
    /** Tracker refs of the mirrored Tasks under this Map. */
    taskRefs: z.array(z.number()).meta({ example: [30, 35] }),
    /** Task count per state (the keys are TaskStates present under this Map). */
    counts: z.record(z.string(), z.number()).meta({ example: { ready: 1, completed: 1 } }),
  })
  .meta({ id: 'Map' });

const mapsListResponseSchema = z.object({ maps: z.array(mapSchema) });

const refParamsSchema = z.object({ ref: z.coerce.number().int().meta({ example: 19 }) });

export async function mapRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/maps',
    {
      schema: {
        tags: ['Maps'],
        description:
          'The derived Map rollup: every Map from the last tracker poll with its member Tasks and per-state counts. Query-time (no table); empty when tracker mirroring is off or before the first poll. Reachable with a read-scoped API Key.',
        response: { 200: mapsListResponseSchema.describe('Every derived Map, newest tracker scan.') },
      },
    },
    async () => ({ maps: ctx.trackerPoller.maps() }),
  );

  app.get(
    '/maps/:ref',
    {
      schema: {
        tags: ['Maps'],
        description: 'One derived Map by its tracker ref. Reachable with a read-scoped API Key.',
        params: refParamsSchema,
        response: {
          200: mapSchema.describe('The Map, with its member Tasks and per-state counts.'),
          404: errorResponse('No Map with that ref in the last tracker scan.'),
        },
      },
    },
    async (req) => {
      const map = ctx.trackerPoller.maps().find((m) => m.ref === req.params.ref);
      if (!map) throw new DomainError('not_found', `no map with ref ${req.params.ref}`);
      return map;
    },
  );
}
