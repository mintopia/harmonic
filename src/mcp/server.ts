import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../server/app.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES } from '../config.js';
import { serializeRun } from '../domain/runs.js';
import { DomainError } from '../domain/errors.js';

const taskId = { taskId: z.number().int().positive().describe('Task id') };

/**
 * The agent-facing MCP surface: everything needed to build autonomous
 * pipelines — task CRUD, dependencies, queue/cancel, and read access to
 * runs and run events. Accept/Reject exist only behind the agent-review
 * config flag (default off): the merge gate stays human unless full
 * autonomy is deliberately enabled (ADR-0002).
 *
 * A new server is built per request (stateless streamable HTTP), so the
 * tool list always reflects the current config.
 */
export function buildMcpServer(ctx: AppContext): McpServer {
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
    wrap((args) => ctx.tasks.withDeps(ctx.tasks.create(args))),
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
    wrap((args) => ctx.tasks.listWithDeps(args)),
  );

  server.registerTool(
    'get_task',
    { description: 'Get a Task with its dependencies and dependents.', inputSchema: taskId },
    wrap(({ taskId }) => ctx.tasks.withDeps(ctx.tasks.get(taskId))),
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
    wrap(({ taskId, ...patch }) => ctx.tasks.withDeps(ctx.tasks.update(taskId, patch))),
  );

  server.registerTool(
    'queue_task',
    {
      description:
        'Queue a Task for execution: promotes a draft to ready, or re-queues a failed Task (optionally with feedback appended to its prompt).',
      inputSchema: { ...taskId, feedback: z.string().optional() },
    },
    wrap(({ taskId, feedback }) => {
      const task = ctx.tasks.get(taskId);
      const queued = task.state === 'failed' ? ctx.tasks.requeue(taskId, feedback) : ctx.tasks.promote(taskId);
      return ctx.tasks.withDeps(queued);
    }),
  );

  server.registerTool(
    'cancel_task',
    {
      description: 'Cancel a Task (any non-terminal state); optionally cancel everything depending on it too.',
      inputSchema: { ...taskId, withDependents: z.boolean().optional() },
    },
    wrap(({ taskId, withDependents }) => {
      if (withDependents) {
        const cancelled = ctx.tasks.cancelWithDependents(taskId);
        cancelled.forEach((id) => ctx.runner.cancelForTask(id));
        return { cancelled };
      }
      const task = ctx.tasks.cancel(taskId);
      ctx.runner.cancelForTask(taskId);
      return ctx.tasks.withDeps(task);
    }),
  );

  server.registerTool(
    'add_dependency',
    {
      description: 'Make a Task depend on another (dependent stays blocked until the dependency is completed). Cycles are rejected.',
      inputSchema: { ...taskId, dependsOnId: z.number().int().positive() },
    },
    wrap(({ taskId, dependsOnId }) => ctx.tasks.addDependency(taskId, dependsOnId)),
  );

  server.registerTool(
    'remove_dependency',
    {
      description: 'Remove a dependency edge from a Task.',
      inputSchema: { ...taskId, dependsOnId: z.number().int().positive() },
    },
    wrap(({ taskId, dependsOnId }) => ctx.tasks.removeDependency(taskId, dependsOnId)),
  );

  server.registerTool(
    'get_runs',
    { description: "List a Task's Runs with their results and usage; a retry is a new Run.", inputSchema: taskId },
    wrap(({ taskId }) => {
      ctx.tasks.get(taskId);
      return ctx.runs.listForTask(taskId).map(serializeRun);
    }),
  );

  server.registerTool(
    'get_run_events',
    {
      description: "Read a Run's full event stream (every ACP session/update, permission grants, lifecycle).",
      inputSchema: { runId: z.number().int().positive() },
    },
    wrap(({ runId }) => ctx.runs.listEvents(runId)),
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
    wrap(({ taskId }) => {
      ctx.tasks.get(taskId); // 404s a bad id via DomainError
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
    wrap(({ taskId, reason }) => {
      ctx.tasks.get(taskId); // 404s a bad id via DomainError
      return { acknowledged: true, running: ctx.runner.markEscalate(taskId, reason) };
    }),
  );

  return server;
}
