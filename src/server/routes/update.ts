import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse } from '../schemas.js';

const updateInstructionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: z.string() }).describe('An exact shell command the operator can copy and run to upgrade manually.'),
  z.object({ kind: z.literal('manual'), instructions: z.string() }).describe('Free-text upgrade instructions, used when no exact command is known.'),
]);

const updateModeSchema = z.object({
  kind: z.enum(['systemd', 'initd', 'migration-required', 'external']),
  instruction: updateInstructionSchema.optional(),
});

const updateFailureSchema = z.object({
  targetVersion: z.string(),
  reason: z.string(),
  at: z.string(),
});

const updateStateSchema = z.object({
  currentVersion: z.string(),
  availableVersion: z.string().nullable(),
  armedVersion: z.string().nullable(),
  upgradingVersion: z.string().nullable(),
  dismissedVersion: z.string().nullable(),
  migrationRequired: z.boolean(),
  guardMissing: z.boolean(),
  mode: updateModeSchema,
  failed: updateFailureSchema.nullable(),
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
  ctx: Pick<AppContext, 'distributionMode' | 'upgrade' | 'updateCheck' | 'runningVersion' | 'installMode' | 'guardMissing'>,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const response = async () => {
    const [state, idle, migrationRequired] = await Promise.all([ctx.upgrade.state(), ctx.upgrade.idleState(), ctx.upgrade.migrationRequired()]);
    const phase = state.phase;
    const installMode = ctx.installMode;
    const mode = installMode.kind === 'external'
      ? { kind: installMode.kind, ...(state.version === null ? {} : { instruction: installMode.instructionFor(state.version) }) }
      : { kind: installMode.kind };
    return {
      currentVersion: ctx.runningVersion,
      availableVersion: state.version,
      armedVersion: phase.kind === 'armed' || phase.kind === 'upgrading' ? phase.targetVersion : null,
      upgradingVersion: phase.kind === 'upgrading' ? phase.targetVersion : null,
      dismissedVersion: state.dismissedVersion,
      migrationRequired,
      guardMissing: ctx.guardMissing,
      mode,
      failed: phase.kind === 'failed' ? { targetVersion: phase.targetVersion, reason: phase.reason, at: phase.at } : null,
      idle,
    };
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
      response: { 200: updateStateSchema.describe('The newly armed update and current drain-to-idle blockers.'), 409: errorResponse('No update is currently available to arm, or a previously armed one is already switching versions.') },
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
      response: {
        200: updateStateSchema.describe('The unarmed update state and current drain-to-idle blockers, or the unchanged state if the swap has already started stopping and hasn\'t yet.'),
        409: errorResponse('The swap has already committed to the new version and can no longer be cancelled.'),
      },
    },
  }, async () => {
    assertPackaged(ctx.distributionMode);
    await ctx.upgrade.cancel();
    return response();
  });

  app.post('/update/dismiss', {
    schema: {
      tags: ['Update'],
      description: 'Dismiss the currently offered update until a newer version is published. Operator only.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      response: { 200: updateStateSchema.describe('The dismissed update and current drain-to-idle blockers.') },
    },
  }, async () => {
    assertPackaged(ctx.distributionMode);
    await ctx.upgrade.dismiss();
    return response();
  });

  app.post('/update/check', {
    schema: {
      tags: ['Update'],
      description: 'Check now for a newer published version instead of waiting for the hourly check. Operator only.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      response: { 200: updateStateSchema.describe('The current offered and armed update, with drain-to-idle blockers.') },
    },
  }, async () => {
    assertPackaged(ctx.distributionMode);
    await ctx.updateCheck.run();
    return response();
  });
}
