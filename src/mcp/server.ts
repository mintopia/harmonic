import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../server/app.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES } from '../config.js';
import { TASK_STATES } from '../db/schema.js';
import { serializeAttempt } from '../domain/attempts.js';
import { DomainError } from '../domain/errors.js';

const taskId = { taskId: z.number().int().positive().describe('Task id') };

/**
 * The agent-facing MCP surface: everything needed to build autonomous
 * pipelines — task CRUD, dependencies, queue/cancel, and read access to
 * runs and run events.
 *
 * A new server is built per request (stateless streamable HTTP), so the
 * tool list always reflects the current config. `opts.operator` gates the
 * operator-only tools (e.g. `force_integrate_epic`) — default `false` (treat
 * an unspecified caller as non-operator) so a caller of this function that
 * hasn't been updated to compute the real value fails closed rather than
 * accidentally exposing operator actions to a Attempt Key.
 */
export function buildMcpServer(ctx: AppContext, opts: { operator?: boolean } = {}): McpServer {
  const operator = opts.operator ?? false;
  const server = new McpServer({ name: 'harmonic', version: '0.1.0' });

  const json = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  /** Operator-only tool guard: thrown as a `DomainError` so `wrapAsync`
   * reports it the same way any other domain rejection is reported, rather
   * than a raw 500. */
  const requireOperator = () => {
    if (!operator) {
      throw new DomainError('forbidden', 'operator-only: this action requires an operator credential');
    }
  };

  const wrapAsync = <A, R>(fn: (args: A) => Promise<R>) => {
    return async (args: A) => {
      try {
        return json(await fn(args));
      } catch (err) {
        if (err instanceof DomainError) {
          return {
            content: [{ type: 'text' as const, text: `Error (${err.code}): ${err.message}` }],
            isError: true,
          };
        }
        throw err;
      }
    };
  };

  server.registerTool(
    'create_task',
    {
      description:
        'Create a Task (a prompt plus execution settings). Defaults come from global config; pass state "draft" to author without executing, and dependsOn to gate on other tasks.',
      inputSchema: {
        prompt: z.string().min(1),
        harness: z.enum(HARNESS_IDS).optional(),
        model: z.string().optional(),
        workingDir: z.string().optional(),
        isolationMode: z.enum(ISOLATION_MODES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        conflictResolveTurns: z.number().int().min(0).optional(),
        state: z.enum(['draft', 'ready']).optional(),
        dependsOn: z.array(z.number().int().positive()).optional(),
      },
    },
    wrapAsync(async (args) => ctx.tasks.withDeps(await ctx.tasks.create(args))),
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'List Tasks, optionally filtered by state, harness, or priority.',
      inputSchema: {
        state: z
          .enum(TASK_STATES)
          .optional(),
        harness: z.enum(HARNESS_IDS).optional(),
        priority: z.enum(PRIORITIES).optional(),
      },
    },
    wrapAsync((args) => ctx.tasks.listWithDeps(args)),
  );

  server.registerTool(
    'get_task',
    { description: 'Get a Task with its dependencies and dependents.', inputSchema: taskId },
    wrapAsync(async ({ taskId }) => ctx.tasks.withDeps(await ctx.tasks.get(taskId))),
  );

  server.registerTool(
    'update_task',
    {
      description: 'Edit a draft or ready Task (prompt and execution settings).',
      inputSchema: {
        ...taskId,
        prompt: z.string().min(1).optional(),
        harness: z.enum(HARNESS_IDS).optional(),
        model: z.string().optional(),
        workingDir: z.string().optional(),
        isolationMode: z.enum(ISOLATION_MODES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        conflictResolveTurns: z.number().int().min(0).optional(),
      },
    },
    wrapAsync(async ({ taskId, ...patch }) => ctx.tasks.withDeps(await ctx.tasks.update(taskId, patch))),
  );

  server.registerTool(
    'queue_task',
    {
      description:
        'Queue a Task for execution: promotes a draft to ready. An escalated Task is a human decision (Accept / Reject with guidance / Close), never re-queued from here.',
      inputSchema: { ...taskId },
    },
    wrapAsync(async ({ taskId }) => ctx.tasks.withDeps(await ctx.tasks.promote(taskId))),
  );

  server.registerTool(
    'cancel_task',
    {
      description: 'Cancel a Task (any non-terminal state); optionally cancel everything depending on it too.',
      inputSchema: { ...taskId, withDependents: z.boolean().optional() },
    },
    wrapAsync(async ({ taskId, withDependents }) => {
      if (withDependents) {
        const cancelled = await ctx.tasks.cancelWithDependents(taskId);
        cancelled.forEach((id) => ctx.runner.cancelForTask(id));
        return { cancelled };
      }
      const task = await ctx.tasks.cancel(taskId);
      ctx.runner.cancelForTask(taskId);
      return ctx.tasks.withDeps(task);
    }),
  );

  server.registerTool(
    'delete_task',
    {
      description:
        'Permanently delete a Task and its Runs, Usage, and Dependency edges (a mirrored Task is also dismissed so a re-poll will not re-create it). Distinct from cancel_task, which keeps the record. Rejected while the Task is running.',
      inputSchema: { ...taskId },
    },
    wrapAsync(async ({ taskId }) => {
      ctx.runner.cancelForTask(taskId);
      await ctx.tasks.delete(taskId);
      return { deleted: taskId };
    }),
  );

  server.registerTool(
    'add_dependency',
    {
      description: 'Make a Task depend on another (dependent stays blocked until the dependency is completed). Cycles are rejected.',
      inputSchema: { ...taskId, dependsOnId: z.number().int().positive() },
    },
    wrapAsync(({ taskId, dependsOnId }) => ctx.tasks.addDependency(taskId, dependsOnId)),
  );

  server.registerTool(
    'remove_dependency',
    {
      description: 'Remove a dependency edge from a Task.',
      inputSchema: { ...taskId, dependsOnId: z.number().int().positive() },
    },
    wrapAsync(({ taskId, dependsOnId }) => ctx.tasks.removeDependency(taskId, dependsOnId)),
  );

  server.registerTool(
    'get_attempts',
    { description: "List a Task's Attempts with their results and usage; a retry is a new Attempt.", inputSchema: taskId },
    wrapAsync(async ({ taskId }) => {
      await ctx.tasks.get(taskId);
      return (await ctx.attempts.listForTask(taskId)).map(serializeAttempt);
    }),
  );

  server.registerTool(
    'get_attempt_events',
    {
      description: "Read an Attempt's persisted event stream (permission grants, lifecycle facts).",
      inputSchema: { attemptId: z.number().int().positive() },
    },
    wrapAsync(async ({ attemptId }) => ctx.attempts.listEvents((await ctx.attempts.get(attemptId)).id)),
  );

  server.registerTool(
    'finish_task',
    {
      description:
        'Signal that this Task is finished (the execution-complete signal) so Harmonic stops re-prompting ' +
        'you to continue. Call only when the work is genuinely complete. Do NOT close the tracker ticket ' +
        'yourself — Harmonic verifies the work, merges it, and then closes the ticket itself. Ending your ' +
        'turn without this leaves the run looking parked, and Harmonic will prompt you to continue.',
      inputSchema: { ...taskId, summary: z.string().optional().describe('Optional note on what was finished') },
    },
    wrapAsync(async ({ taskId }) => {
      await ctx.tasks.get(taskId); // 404s a bad id via DomainError
      return { acknowledged: true, running: ctx.runner.markAgentFinished(taskId) };
    }),
  );

  server.registerTool(
    'escalate_task',
    {
      description:
        'Escalate this Task to a human because you are blocked: a decision you cannot take, input you do ' +
        'not have, or something you should not resolve unattended — instead of guessing or idle-waiting. ' +
        'This hands the ticket to a human right away and supersedes any remaining retry budget; your ' +
        '`reason` is recorded as the escalation cause.',
      inputSchema: { ...taskId, reason: z.string().min(1).describe('Why you are blocked') },
    },
    wrapAsync(async ({ taskId, reason }) => {
      await ctx.tasks.get(taskId); // 404s a bad id via DomainError
      return { acknowledged: true, running: ctx.runner.markEscalate(taskId, reason) };
    }),
  );

  server.registerTool(
    'force_integrate_epic',
    {
      description:
        "Operator only. Force-integrate an Epic's ready subset: merge whatever is folded into its integration branch " +
        'into the default branch now, bypassing the all-members-completed gate — but not Verification, which ' +
        'still gates the merge (a failing whole-Epic Verification still escalates rather than merging). Returns ' +
        'the merge attempt outcome, or a forbidden/not-found domain error when tracking is off for the Workspace.',
      inputSchema: {
        workspaceId: z.number().int().positive().describe('The owning Workspace id'),
        epicRef: z.number().int().positive().describe("The Epic's tracker ref"),
      },
    },
    wrapAsync(async ({ workspaceId, epicRef }) => {
      requireOperator();
      await ctx.workspaces.get(workspaceId); // 404s an unknown Workspace before touching the tracker
      const outcome = await ctx.trackerManager.forceIntegrateEpic(workspaceId, epicRef);
      if (!outcome) {
        throw new DomainError(
          'conflict',
          `no active whole-Epic integrate coordinator for workspace ${workspaceId} (tracking is off or the loop has not started)`,
        );
      }
      return outcome;
    }),
  );

  return server;
}
