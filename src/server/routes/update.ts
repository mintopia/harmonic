import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse } from '../schemas.js';

const updateStateSchema = z.object({
  availableVersion: z.string().nullable(),
  armedVersion: z.string().nullable(),
  idle: z.object({
    runningAttempts: z.number().int().nonnegative(),
    mergingOrIntegrating: z.boolean(),
    conversationMidTurn: z.boolean(),
  }),
});

function assertPackaged(distributionMode: AppContext['distributionMode']): void {
  if (distributionMode !== 'packaged') throw new DomainError('invalid_state', 'in-place upgrades are only available for packaged instances');
}

export async function updateRoutes(
  fastify: FastifyInstance,
  ctx: Pick<AppContext, 'distributionMode' | 'upgrade'>,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const response = async () => {
    const [state, idle] = await Promise.all([ctx.upgrade.state(), ctx.upgrade.idleState()]);
    return { availableVersion: state.version, armedVersion: state.armedVersion, idle };
  };

  app.get('/update', {
    schema: {
      tags: ['Update'],
      description: 'The offered and armed package update, plus the current drain-to-idle blockers. Operator only.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      response: { 200: updateStateSchema.describe('The current offered and armed update, with drain-to-idle blockers.') },
    },
  }, async () => {
    assertPackaged(ctx.distributionMode);
    return response();
  });

  app.post('/update/arm', {
    schema: {
      tags: ['Update'],
      description: 'Pin the currently offered update and quiesce new work until the instance is idle. Operator only.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      response: { 200: updateStateSchema.describe('The newly armed update and current drain-to-idle blockers.'), 409: errorResponse('No update is currently available to arm.') },
    },
  }, async () => {
    assertPackaged(ctx.distributionMode);
    await ctx.upgrade.arm();
    return response();
  });

  app.delete('/update/arm', {
    schema: {
      tags: ['Update'],
      description: 'Cancel an armed update and restore the Auto-Runner master switch to its pre-arm value. Operator only.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      response: { 200: updateStateSchema.describe('The unarmed update state and current drain-to-idle blockers.') },
    },
  }, async () => {
    assertPackaged(ctx.distributionMode);
    await ctx.upgrade.cancel();
    return response();
  });
}
