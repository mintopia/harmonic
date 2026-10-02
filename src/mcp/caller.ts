import type { FastifyRequest } from 'fastify';
import type { AttemptRow, TaskRow, WorkspaceRow } from '../db/schema.js';
import type { AppContext } from '../server/app.js';

export type McpKeyScope = 'full' | 'attempt' | 'conversation' | 'read';

/** Who is calling the MCP endpoint: a scoped key's owner, or an operator credential (`scope: null`). */
export interface McpCaller {
  scope: McpKeyScope | null;
  attempt: AttemptRow | null;
  task: TaskRow | null;
  workspace: WorkspaceRow | null;
}

const OPERATOR: McpCaller = { scope: null, attempt: null, task: null, workspace: null };

export async function resolveMcpCaller(ctx: AppContext, req: FastifyRequest): Promise<McpCaller> {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const key = bearer ? await ctx.auth.verifyKey(bearer) : null;
  // The auth hook rejects read keys on /mcp and falls back to the session cookie, so a read key is no caller identity.
  if (!key || key.scope === 'read') return OPERATOR;
  const scope = key.scope as McpKeyScope;
  if (key.scope !== 'attempt' || key.attemptId === null) return { ...OPERATOR, scope };

  const attempt = await ctx.attempts.get(key.attemptId).catch(() => null);
  if (!attempt) return { ...OPERATOR, scope };
  const task = attempt.taskId === null ? null : await ctx.tasks.get(attempt.taskId).catch(() => null);
  const workspaceId = task?.workspaceId ?? attempt.workspaceId;
  const workspace = workspaceId === null ? null : await ctx.workspaces.get(workspaceId).catch(() => null);
  return { scope, attempt, task, workspace };
}
