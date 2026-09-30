import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OperatorAction, OperatorActor } from '../archive/task-archive.js';
import { forEachYielding } from '../reliability/yield.js';
import { logger } from '../logger.js';
import type { AppContext } from './app.js';
import { requestIsOperator } from './auth.js';

export const operatorReasonSchema = z
  .string()
  .trim()
  .max(2000)
  .transform((value) => (value === '' ? null : value))
  .optional();

export async function requestActor(req: FastifyRequest, ctx: Pick<AppContext, 'auth'>): Promise<OperatorActor> {
  return (await requestIsOperator(req, ctx.auth)) ? 'operator' : 'agent';
}

type FactEvent = 'operator-accepted' | 'operator-closed' | 'operator-cancelled';

const FACT_EVENTS: Partial<Record<OperatorAction, FactEvent>> = {
  accept: 'operator-accepted',
  close: 'operator-closed',
  cancel: 'operator-cancelled',
};

export async function recordOperatorActionBestEffort(
  ctx: Pick<AppContext, 'tasks' | 'archive' | 'taskEvents' | 'bus'>,
  taskId: number,
  actor: OperatorActor,
  action: OperatorAction,
  text: string | null,
): Promise<void> {
  try {
    const task = await ctx.tasks.get(taskId);
    await ctx.archive.recordOperatorInput(task, { actor, action, text });
    const event = FACT_EVENTS[action];
    if (event) {
      await ctx.taskEvents.appendEvent(taskId, { event, actor, reason: action === 'accept' ? null : text });
      ctx.bus.emit('step_changed', { taskId });
    }
  } catch (err) {
    logger.warn('operator input record failed', { taskId, action, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function deleteTaskKeepingArchive(
  ctx: Pick<AppContext, 'tasks' | 'runner' | 'archive'>,
  taskId: number,
  actor: OperatorActor,
): Promise<void> {
  const task = await ctx.tasks.get(taskId);
  ctx.runner.cancelForTask(taskId);
  await ctx.tasks.delete(taskId);
  await ctx.archive.recordDeletion(task, actor);
}

export async function recordOperatorActionsBestEffort(
  ctx: Pick<AppContext, 'tasks' | 'archive' | 'taskEvents' | 'bus'>,
  taskIds: readonly number[],
  actor: OperatorActor,
  action: OperatorAction,
  text: string | null,
): Promise<void> {
  await forEachYielding(taskIds, (taskId) => recordOperatorActionBestEffort(ctx, taskId, actor, action, text));
}
