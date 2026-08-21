import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { LEASE_STATES } from '../../db/schema.js';
import { buildLeaseDiagnostics } from '../../domain/lease-diagnostics.js';
import { errorResponse, okResponseSchema } from '../schemas.js';

/** One Work Context lease's operator-facing diagnostic row (`LeaseDiagnostic`,
 * domain/lease-diagnostics.ts) as the API serves it. */
const leaseDiagnosticSchema = z
  .object({
    key: z.string().meta({ example: 'direct:/home/dev/harmonic' }),
    state: z.enum(LEASE_STATES).meta({ example: 'suspect' }),
    phase: z.string().meta({ example: 'executing' }),
    ownerRunId: z.number().meta({ example: 4821 }),
    ownerTaskId: z.number().nullable().meta({ example: 512 }),
    ownerTaskTitle: z.string().nullable().meta({ example: 'Add the Activity rail view' }),
    ownerTaskState: z.string().nullable().meta({ example: 'running' }),
    acquiredAt: z.number().meta({ example: 1784032260000 }),
    heartbeat: z.number().nullable().meta({ example: 1784032320000 }),
    expiry: z.number().nullable().meta({ example: 1784032440000 }),
    /** How long the longest-waiting ready Task blocked on this context has
     * been waiting, in ms; null when nothing is waiting. */
    longestWaitMs: z.number().nullable().meta({ example: 45000 }),
    waitingTaskCount: z.number().meta({ example: 1 }),
  })
  .meta({ id: 'LeaseDiagnostic' });

const leasesListResponseSchema = z.object({ leases: z.array(leaseDiagnosticSchema) });

const supersedeBodySchema = z
  .object({
    key: z.string().min(1).meta({ example: 'direct:/home/dev/harmonic' }),
    runId: z.number().int().positive().meta({ example: 4821 }),
  })
  .meta({ id: 'LeaseSupersedeBody' });

const unlockBodySchema = z
  .object({ key: z.string().min(1).meta({ example: 'direct:/home/dev/harmonic' }) })
  .meta({ id: 'LeaseUnlockBody' });

/**
 * The operator supersede/unlock + queue-diagnostics surface over Work Context
 * leases (issue #125, ADR-0022, reliability-design §0.5): the manual escape
 * for a `suspect` lease boot reconciliation (#123) or the live sweep (#122)
 * could only flag, never resolve. Operator only — not on `scopedKeyAllowed`'s
 * (or `readScopeAllowed`'s) allowlist, so a run-scoped or read-scoped key
 * gets the same 403 an unrecognized path gets by default (see app.ts).
 *
 * Scope: these disposition the **lease** — the authoritative acquire gate in
 * `Runner.beginRun`. Once freed (or re-pointed), the context is admissible on
 * the next `poke`d pick pass for the anti-starvation case this targets: a lease
 * whose owner Run is dead/abandoned, whose Task has already left
 * `running`/`awaiting-review`. A context still physically occupied by a live
 * owner Task in those states stays skipped by the House Rule pick predicate —
 * which reads Task state, not the lease (auto-runner.ts) — and rightly so: that
 * checkout is still in use, and disposing *that* is a Task action
 * (complete/cancel), not a lease action.
 */
export async function leaseRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/leases',
    {
      schema: {
        tags: ['Leases'],
        description:
          'List every Work Context lease with operator diagnostics: owner Run/Task, TTL state, and the ready Tasks queued behind it. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: {
          200: leasesListResponseSchema.describe('Every held or suspect lease, with its queue diagnostics.'),
        },
      },
    },
    async () => ({
      leases: buildLeaseDiagnostics({
        leases: ctx.leases.listAll(),
        runs: await ctx.runs.listAll(),
        tasks: await ctx.tasks.list(),
        waitingSince: (id) => ctx.autoRunner.waitingSince(id),
        now: Date.now(),
      }),
    }),
  );

  app.post(
    '/leases/supersede',
    {
      schema: {
        tags: ['Leases'],
        description:
          'Re-point a stuck lease to a Run the operator names, re-admitting it as held with a fresh TTL — the escape for a suspect lease reconciliation could not resolve on its own. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: supersedeBodySchema,
        response: {
          200: okResponseSchema.describe('The lease now belongs to the named Run.'),
          404: errorResponse('No lease is held for that key, or no Run has that id.'),
        },
      },
    },
    async (req) => {
      await ctx.runs.get(req.body.runId); // 404s an unknown Run before touching the lease
      ctx.leases.supersede(req.body.key, req.body.runId);
      ctx.autoRunner.poke();
      return { ok: true } as const;
    },
  );

  app.post(
    '/leases/unlock',
    {
      schema: {
        tags: ['Leases'],
        description:
          'Force-release a lease outright, freeing its key for a fresh acquire — use when no Run should inherit the stuck context. Operator only.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        body: unlockBodySchema,
        response: {
          200: okResponseSchema.describe('The lease was released; the key is free for a fresh acquire.'),
          404: errorResponse('No lease is held for that key.'),
        },
      },
    },
    async (req) => {
      ctx.leases.forceRelease(req.body.key);
      ctx.autoRunner.poke();
      return { ok: true } as const;
    },
  );
}
