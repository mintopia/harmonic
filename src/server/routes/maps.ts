import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TrackingContext } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse } from '../schemas.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

/**
 * A derived Map: a `wayfinder:map` issue paired with the mirrored Tasks that
 * share its mapRef, plus per-state counts. Not stored — a query-time rollup
 * over the last poll's scan.
 */
const mapSchema = z
  .object({
    workspaceId: z.number().meta({ example: 1 }),
    ref: z.number().meta({ example: 19 }),
    title: z.string().meta({ example: 'Wayfinder' }),
    url: z.string().meta({ example: 'https://github.com/mintopia/harmonic/issues/19' }),
    /** Tracker refs of the mirrored Tasks under this Map. */
    taskRefs: z.array(z.number()).meta({ example: [30, 35] }),
    /** Task count per state (the keys are TaskStates present under this Map). */
    counts: z.record(z.string(), z.number()).meta({ example: { ready: 1, completed: 1 } }),
  })
  .meta({ id: 'Map' });

const mapsListResponseSchema = listResponse('maps', mapSchema);

const refParamsSchema = z.object({ ref: z.coerce.number().int().meta({ example: 19 }) });
const workspaceQuerySchema = z.object({
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 1 }),
});

/** The `GET /maps` querystring: the optional Workspace scope and shared pagination
 * fragment plus a case-insensitive substring search over the Map title. */
const mapsListQuerySchema = workspaceQuerySchema.extend(paginationQuerySchema.shape).extend({
  q: z.string().optional().meta({ example: 'Wayfinder' }),
});

export async function mapRoutes(fastify: FastifyInstance, ctx: Pick<TrackingContext, 'trackerManager'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/maps',
    {
      schema: {
        tags: ['Maps'],
        description:
          "The derived Map rollup: every Map from the last tracker poll with its member Tasks and per-state counts, each stamped with its Workspace. `?workspaceId=` scopes to one Workspace's board (issue #45). Searched (`q`, case-insensitive substring over the Map title) and paginated (`limit`/`offset`, with a `total`). Query-time (no table); empty when tracker mirroring is off or before the first poll. Reachable with a read-scoped API Key.",
        querystring: mapsListQuerySchema,
        response: { 200: mapsListResponseSchema.describe('Every derived Map, newest tracker scan.') },
      },
    },
    async (req) => {
      const { workspaceId, limit, offset, q } = req.query;
      const maps = await ctx.trackerManager.maps(workspaceId);
      const needle = q?.trim().toLowerCase();
      const matched = needle ? maps.filter((m) => m.title.toLowerCase().includes(needle)) : maps;
      const { items, total } = paginate(matched, { limit, offset });
      return { maps: items, total };
    },
  );

  app.get(
    '/maps/:ref',
    {
      schema: {
        tags: ['Maps'],
        description:
          'One derived Map by its tracker ref. `?workspaceId=` disambiguates a ref shared across repos (issue #45). Reachable with a read-scoped API Key.',
        params: refParamsSchema,
        querystring: workspaceQuerySchema,
        response: {
          200: mapSchema.describe('The Map, with its member Tasks and per-state counts.'),
          404: errorResponse('No Map with that ref in the last tracker scan.'),
        },
      },
    },
    async (req) => {
      const map = (await ctx.trackerManager.maps(req.query.workspaceId)).find((m) => m.ref === req.params.ref);
      if (!map) throw new DomainError('not_found', `no map with ref ${req.params.ref}`);
      return map;
    },
  );
}
