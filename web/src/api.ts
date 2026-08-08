import type {
  AppConfig,
  Channel,
  Conversation,
  ConversationEvent,
  Cost,
  PermissionRule,
  Run,
  RunEvent,
  Task,
  Workspace,
} from './types';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? res.statusText);
  return json as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  updateConfig: (patch: object) => request<AppConfig>('PATCH', '/api/config', patch),
  replaceConfig: (config: AppConfig) => request<AppConfig>('PUT', '/api/config', config),
  tasks: (workspaceId?: number) =>
    request<{ tasks: Task[] }>('GET', workspaceId ? `/api/tasks?workspaceId=${workspaceId}` : '/api/tasks'),
  task: (id: number) => request<Task>('GET', `/api/tasks/${id}`),
  createTask: (input: Partial<Task> & { prompt: string; state?: 'draft' | 'ready' }) =>
    request<Task>('POST', '/api/tasks', input),
  workspaces: () => request<{ workspaces: Workspace[] }>('GET', '/api/workspaces'),
  createWorkspace: (input: { name: string; workingDir: string }) =>
    request<Workspace>('POST', '/api/workspaces', input),
  updateWorkspace: (
    id: number,
    patch: { name?: string; workingDir?: string; trackerEnabled?: boolean; trackerPollIntervalSeconds?: number },
  ) => request<Workspace>('PATCH', `/api/workspaces/${id}`, patch),
  updateTask: (id: number, input: Partial<Task>) => request<Task>('PATCH', `/api/tasks/${id}`, input),
  promoteTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/ready`),
  cancelTask: (id: number, withDependents = false) =>
    request<Task>('POST', `/api/tasks/${id}/cancel`, withDependents ? { withDependents } : {}),
  addDependency: (id: number, dependsOnId: number) =>
    request<Task>('POST', `/api/tasks/${id}/dependencies`, { dependsOnId }),
  removeDependency: (id: number, depId: number) =>
    request<Task>('DELETE', `/api/tasks/${id}/dependencies/${depId}`),
  /** Create a new task that re-attempts the original, carrying optional feedback. */
  reattempt: (id: number, feedback?: string) =>
    request<Task>('POST', `/api/tasks/${id}/reattempt`, feedback ? { feedback } : {}),
  acceptTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/accept`),
  rejectTask: (id: number, feedback?: string) =>
    request<Task>('POST', `/api/tasks/${id}/reject`, feedback ? { feedback } : {}),
  runTask: (id: number) => request<Run>('POST', `/api/tasks/${id}/run`),
  unescalateTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/unescalate`),
  taskRuns: (id: number) => request<{ runs: Run[] }>('GET', `/api/tasks/${id}/runs`),
  taskUsage: (id: number) =>
    request<{ cost: Cost | null; runCount: number }>('GET', `/api/tasks/${id}/usage`),
  run: (id: number) => request<Run>('GET', `/api/runs/${id}`),
  runEvents: (id: number) => request<{ events: RunEvent[] }>('GET', `/api/runs/${id}/events`),
  runDiff: (id: number) =>
    request<{ branch: string | null; baseBranch: string | null; stat: string | null }>(
      'GET',
      `/api/runs/${id}/diff`,
    ),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/change-password', { currentPassword, newPassword }),

  removePassword: (currentPassword: string) =>
    request<{ ok: true }>('DELETE', '/api/auth/password', { currentPassword }),
  conversations: (workspaceId?: number) =>
    request<{ conversations: Conversation[] }>(
      'GET',
      workspaceId ? `/api/conversations?workspaceId=${workspaceId}` : '/api/conversations',
    ),
  conversation: (id: number) => request<Conversation>('GET', `/api/conversations/${id}`),
  createConversation: (input: { workspaceId?: number; harness?: string; model?: string; workingDir?: string }) =>
    request<Conversation>('POST', '/api/conversations', input),
  // title: null clears an operator-set title, falling back to the one
  // derived from the first Turn (issue #15's LOCKED contract).
  renameConversation: (id: number, title: string | null) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, { title }),
  // Cascades events and revokes the conversation's key server-side; the
  // panel removes it from the list locally on success (no WS broadcast).
  deleteConversation: (id: number) => request<{ ok: true }>('DELETE', `/api/conversations/${id}`),
  conversationEvents: (id: number) =>
    request<{ events: ConversationEvent[] }>('GET', `/api/conversations/${id}/events`),
  // `queued: true` (issue #14's LOCKED contract) means a Turn was already
  // running server-side and this message was enqueued as the next Turn
  // rather than started immediately.
  sendTurn: (id: number, text: string) =>
    request<{ ok: true; queued: boolean }>('POST', `/api/conversations/${id}/turns`, { text }),
  endConversation: (id: number) => request<Conversation>('POST', `/api/conversations/${id}/end`),
  // Cancels the in-flight Turn (ACP session/cancel); a non-empty `text`
  // becomes the next Turn, an empty/omitted one just stops it (issue #14).
  // `text` is included in the body only when non-empty, mirroring
  // answerPermission's optional `remember` below.
  interrupt: (id: number, text?: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/interrupt`, text ? { text } : {}),
  // remember (issue #13 / ADR-0007) is omitted from the body entirely unless
  // true — the escalation is opt-in, so the common one-off answer stays a
  // plain { optionId } post exactly as before.
  answerPermission: (conversationId: number, reqId: string, optionId: string, remember?: boolean) =>
    request<{ ok: true }>(
      'POST',
      `/api/conversations/${conversationId}/permissions/${reqId}`,
      remember ? { optionId, remember } : { optionId },
    ),
  permissionRules: () => request<{ rules: PermissionRule[] }>('GET', '/api/permission-rules'),
  deletePermissionRule: (id: number) => request<unknown>('DELETE', `/api/permission-rules/${id}`),
  channels: () => request<{ channels: Channel[] }>('GET', '/api/channels'),
  createChannel: (input: { name: string; type: Channel['type']; config: Record<string, unknown> }) =>
    request<Channel>('POST', '/api/channels', input),
  updateChannel: (id: number, patch: { events: string[] }) =>
    request<Channel>('PATCH', `/api/channels/${id}`, patch),
  deleteChannel: (id: number) => request<unknown>('DELETE', `/api/channels/${id}`),
};
