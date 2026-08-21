import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../server/app.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES } from '../config.js';
import { serializeRun } from '../domain/runs.js';
import { DomainError } from '../domain/errors.js';
import { buildLeaseDiagnostics } from '../domain/lease-diagnostics.js';

const taskId = { taskId: z.number().int().positive().describe('Task id') };

/**
 * The agent-facing MCP surface: everything needed to build autonomous
 * pipelines — task CRUD, dependencies, queue/cancel, and read access to
 * runs and run events. Accept/Reject exist only behind the agent-review
 * config flag (default off): the merge gate stays human unless full
 * autonomy is deliberately enabled (ADR-0002).
 *
 * A new server is built per request (stateless streamable HTTP), so the
 * tool list always reflects the current config. `opts.operator` (issue #125)
 * gates the Work Context lease disposition tools — default `false` (treat an
 * unspecified caller as non-operator) so a caller of this function that
 * hasn't been updated to compute the real value fails closed rather than
 * accidentally exposing operator actions to a Run Key.
 */
export function buildMcpServer(ctx: AppContext, opts: { operator?: boolean } = {}): McpServer {
  const operator = opts.operator ?? false;
  const server = new McpServer({ name: 'harmonic', version: '0.1.0' });

  const json = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  const wrap = <A, R>(fn: (args: A) => R) => {
    return (args: A) => {
      try {
        return json(fn(args));
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

  /** Operator-only tool guard (issue #125): thrown as a `DomainError` so
   * `wrap` reports it the same way any other domain rejection is reported,
   * rather than a raw 500. */
  const requireOperator = () => {
    if (!operator) {
      throw new DomainError('forbidden', 'operator-only: lease disposition requires an operator credential');
    }
  };

  /** Same as {@link wrap}, for a tool whose handler is async (issue #161's
   * `force_land_epic` is the first — every existing tool is synchronous). */
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
          .enum(['draft', 'blocked', 'ready', 'running', 'awaiting-review', 'completed', 'failed', 'cancelled'])
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
      },
    },
    wrapAsync(async ({ taskId, ...patch }) => ctx.tasks.withDeps(await ctx.tasks.update(taskId, patch))),
  );

  server.registerTool(
    'queue_task',
    {
      description:
        'Queue a Task for execution: promotes a draft to ready, or re-queues a failed Task (optionally with feedback appended to its prompt).',
      inputSchema: { ...taskId, feedback: z.string().optional() },
    },
    wrapAsync(async ({ taskId, feedback }) => {
      const task = await ctx.tasks.get(taskId);
      const queued = task.state === 'failed' ? await ctx.tasks.requeue(taskId, feedback) : await ctx.tasks.promote(taskId);
      return ctx.tasks.withDeps(queued);
    }),
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
    'get_runs',
    { description: "List a Task's Runs with their results and usage; a retry is a new Run.", inputSchema: taskId },
    wrapAsync(async ({ taskId }) => {
      await ctx.tasks.get(taskId);
      return (await ctx.runs.listForTask(taskId)).map(serializeRun);
    }),
  );

  server.registerTool(
    'get_run_events',
    {
      description: "Read a Run's full event stream (every ACP session/update, permission grants, lifecycle).",
      inputSchema: { runId: z.number().int().positive() },
    },
    wrapAsync(({ runId }) => ctx.runs.listEvents(runId)),
  );

  server.registerTool(
    'finish_task',
    {
      description:
        'Signal that this Task is finished (the execution-complete signal) so Harmonic stops re-prompting ' +
        'you to continue. Call only when the work is genuinely complete. Do NOT close the tracker ticket ' +
        'yourself — Harmonic verifies the work and then closes the ticket itself; a ticket you close before ' +
        'that is reopened and the Task escalated. Ending your turn without this leaves the run looking ' +
        'parked, and Harmonic will prompt you to continue.',
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
        'Raise this Task to a human and stop the run. Call when you are blocked on a decision, ' +
        'need input only a human can give, or hit something you should not resolve unattended — ' +
        'instead of guessing or idle-waiting. Include why in `reason`.',
      inputSchema: { ...taskId, reason: z.string().min(1).describe('Why a human is needed') },
    },
    wrapAsync(async ({ taskId, reason }) => {
      await ctx.tasks.get(taskId); // 404s a bad id via DomainError
      return { acknowledged: true, running: ctx.runner.markEscalate(taskId, reason) };
    }),
  );

  server.registerTool(
    'list_leases',
    {
      description:
        'Operator only. List every Work Context lease with diagnostics: owner Run/Task, TTL state, and the ready Tasks queued behind it.',
      inputSchema: {},
    },
    wrapAsync(async () => {
      requireOperator();
      return buildLeaseDiagnostics({
        leases: ctx.leases.listAll(),
        runs: await ctx.runs.listAll(),
        tasks: await ctx.tasks.list(),
        waitingSince: (id) => ctx.autoRunner.waitingSince(id),
        now: Date.now(),
      });
    }),
  );

  server.registerTool(
    'supersede_lease',
    {
      description:
        'Operator only. Re-point a stuck Work Context lease to a Run you name, re-admitting it as held with a fresh TTL.',
      inputSchema: { key: z.string().min(1).describe('The Work Context key'), runId: z.number().int().positive() },
    },
    wrapAsync(async ({ key, runId }) => {
      requireOperator();
      await ctx.runs.get(runId); // 404s an unknown Run before touching the lease
      const lease = ctx.leases.supersede(key, runId);
      ctx.autoRunner.poke();
      return { ok: true, lease };
    }),
  );

  server.registerTool(
    'unlock_lease',
    {
      description: 'Operator only. Force-release a Work Context lease outright, freeing its key for a fresh acquire.',
      inputSchema: { key: z.string().min(1).describe('The Work Context key') },
    },
    wrap(({ key }) => {
      requireOperator();
      ctx.leases.forceRelease(key);
      ctx.autoRunner.poke();
      return { ok: true };
    }),
  );

  server.registerTool(
    'force_land_epic',
    {
      description:
        "Operator only. Force-land an Epic's ready subset: merge whatever is folded into its integration branch " +
        'into the default branch now, bypassing the all-members-completed gate — but not Verification, which ' +
        'still gates the merge (a failing whole-Epic Verification still escalates rather than landing). Returns ' +
        'the land attempt outcome, or a forbidden/not-found domain error when tracking is off for the Workspace.',
      inputSchema: {
        workspaceId: z.number().int().positive().describe('The owning Workspace id'),
        epicRef: z.number().int().positive().describe("The Epic's tracker ref"),
      },
    },
    wrapAsync(async ({ workspaceId, epicRef }) => {
      requireOperator();
      ctx.workspaces.get(workspaceId); // 404s an unknown Workspace before touching the tracker
      const outcome = await ctx.trackerManager.forceLandEpic(workspaceId, epicRef);
      if (!outcome) {
        throw new DomainError(
          'conflict',
          `no active whole-Epic land coordinator for workspace ${workspaceId} (tracking is off or the loop has not started)`,
        );
      }
      return outcome;
    }),
  );

  return server;
}
