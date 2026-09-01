import type {
  Attempt,
  AppConfig,
  AttemptUsage,
  BudgetGuardrail,
  Channel,
  ContinuationPreview,
  Conversation,
  ConversationEvent,
  Cost,
  DiffFile,
  FsListing,
  GuardrailEvent,
  MapRollup,
  PermissionRule,
  AttemptSummary,
  AttemptEvent,
  AttemptLogEvent,
  Task,
  TicketTimelineEvent,
  VerificationAttempt,
  VerificationCommand,
  VerifierStatus,
  Workspace,
} from './types.js';
import type { Epic, EpicIntegrateOutcome } from './epic-model.js';
import type { Stats } from './stats-model.js';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? res.statusText);
  if (json === null && res.status !== 204) {
    throw new ApiError(res.status, `Empty response from ${method} ${path}`);
  }
  return json as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  updateConfig: (patch: object) => request<AppConfig>('PATCH', '/api/config', patch),
  replaceConfig: (config: AppConfig) => request<AppConfig>('PUT', '/api/config', config),
  /** `open` is an explicit board optimization. Omit it for full task history.
   * The response is the shared paginated envelope: the page under
   * `tasks` plus the filtered `total`. Pass `limit`/`offset` to page through it;
   * omit `limit` for the whole filtered list. */
  tasks: ({ workspaceId, state, parent, limit, offset }: { workspaceId?: number; state?: 'open'; parent?: number; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', String(workspaceId));
    if (state) params.set('state', state);
    if (parent !== undefined) params.set('parent', String(parent));
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const query = params.toString();
    return request<{ tasks: Task[]; total: number }>('GET', query ? `/api/tasks?${query}` : '/api/tasks');
  },
  task: (id: number) => request<Task>('GET', `/api/tasks/${id}`),
  stats: (from: number, to: number, workspaceId: number) =>
    request<Stats>('GET', `/api/stats?from=${from}&to=${to}&workspaceId=${workspaceId}`),
  epicStats: (epicRef: number, workspaceId: number) =>
    request<Stats>('GET', `/api/epics/${epicRef}/stats?workspaceId=${workspaceId}`),
  createTask: (input: Partial<Task> & { prompt: string; state?: 'draft' | 'ready' }) =>
    request<Task>('POST', '/api/tasks', input),
  // Lazy directory picker: one level deep per call; an omitted
  // path starts at the server user's home. Operator-only (full-scope session).
  browseFs: (path?: string) =>
    request<FsListing>('GET', path ? `/api/fs?path=${encodeURIComponent(path)}` : '/api/fs'),
  workspaces: () => request<{ workspaces: Workspace[]; total: number }>('GET', '/api/workspaces'),
  createWorkspace: (input: { name: string; workingDir: string }) =>
    request<Workspace>('POST', '/api/workspaces', input),
  // Overridable fields accept `null` to clear an override
  // back to inherit; an omitted field is left untouched server-side.
  updateWorkspace: (
    id: number,
    patch: {
      name?: string;
      workingDir?: string;
      trackerEnabled?: boolean;
      trackerPollIntervalSeconds?: number;
      harness?: string | null;
      model?: string | null;
      chatHarness?: string | null;
      chatModel?: string | null;
      isolationMode?: 'direct' | 'worktree' | null;
      priority?: 'high' | 'normal' | 'low' | null;
      conflictResolveTurns?: number | null;
      maxConcurrentAttempts?: number | null;
      autoRunnerEnabled?: boolean | null;
      maxAttempts?: number | null;
      contextReuseTokenLimit?: number | null;
      verificationCommand?: VerificationCommand[] | null;
      reviewEnabled?: boolean | null;
      reviewPrompt?: string | null;
      reviewModel?: string | null;
      reviewHarness?: string | null;
      guardrailBudget?: BudgetGuardrail | null;
      guardrailProgress?: boolean | null;
      toolTimeoutMinutes?: number | null;
      drivePrompt?: string | null;
      driveUnattendedReminder?: string | null;
      driveContinuePrompt?: string | null;
      driveMergeFate?: 'auto-merge' | 'open-PR' | 'artifact' | null;
      driveContinueAttempts?: number | null;
      taskPrompt?: string | null;
    },
  ) => request<Workspace>('PATCH', `/api/workspaces/${id}`, patch),
  // Deletes the Workspace and cascades its board; the server 204s (empty body,
  // handled by request's 204 branch). Deleting the last Workspace is allowed
  // — the app falls to the empty state; a running Task 409s.
  deleteWorkspace: (id: number) => request<null>('DELETE', `/api/workspaces/${id}`),
  // Force an immediate tracker poll (the board's manual refresh) — rescans the
  // repo and mirrors changes now. 409 if the Workspace has tracking disabled.
  refreshTracker: (id: number) => request<{ ok: true }>('POST', `/api/workspaces/${id}/tracker/refresh`),
  // The inheritable Task-default fields accept `null` to clear the override
  // back to inherit; other fields keep their non-null Partial<Task> shape.
  updateTask: (
    id: number,
    input: Partial<
      Omit<Task, 'harness' | 'model' | 'isolationMode' | 'priority' | 'conflictResolveTurns'>
    > & {
      harness?: string | null;
      model?: string | null;
      isolationMode?: 'direct' | 'worktree' | null;
      priority?: 'high' | 'normal' | 'low' | null;
      conflictResolveTurns?: number | null;
    },
  ) => request<Task>('PATCH', `/api/tasks/${id}`, input),
  promoteTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/ready`),
  cancelTask: (id: number, withDependents = false) =>
    request<Task>('POST', `/api/tasks/${id}/cancel`, withDependents ? { withDependents } : {}),
  /** Operator override: stop a working task's agent and settle it done, skipping verification. */
  completeTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/complete`),
  /** Steer a running task: queue a message for its active run, delivered at the next turn boundary. */
  steerTask: (id: number, text: string) =>
    request<{ ok: true }>('POST', `/api/tasks/${id}/steer`, { text }),
  uncancelTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/uncancel`),
  addDependency: (id: number, dependsOnId: number) =>
    request<Task>('POST', `/api/tasks/${id}/dependencies`, { dependsOnId }),
  removeDependency: (id: number, depId: number) =>
    request<Task>('DELETE', `/api/tasks/${id}/dependencies/${depId}`),
  continuationPreview: (id: number) => request<ContinuationPreview>('GET', `/api/tasks/${id}/continuation`),
  // The three escalation actions, escalated tickets only.
  // `force: true` is the as-is override (Force-Accept): the server skips
  // candidate verification and merges the branch head as it stands. Omitted
  // (or false) is the default Accept, which verifies first.
  acceptTask: (id: number, opts?: { force?: boolean }) =>
    request<Task>('POST', `/api/tasks/${id}/accept`, opts?.force ? { force: true } : {}),
  rejectTask: (id: number, guidance: string, start = false) =>
    request<Task>('POST', `/api/tasks/${id}/reject`, { guidance, start }),
  closeTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/close`),
  // Hard-delete: cascades the Task's Runs/history and
  // vanishes it from the board/graph via the `task_removed` WS broadcast
  // (App.tsx). 409 if the Task is running (stop it first); 404 if it's
  // already gone.
  deleteTask: (id: number) => request<{ id: number }>('DELETE', `/api/tasks/${id}`),
  runTask: (id: number) => request<AttemptSummary>('POST', `/api/tasks/${id}/run`),
  /** Lean Attempt summaries, oldest first (retries included). */
  taskAttempts: (id: number) => request<{ attempts: AttemptSummary[]; total: number }>('GET', `/api/tasks/${id}/attempts`),
  /** Ordered durable Attempt/Task history for the ticket page. */
  taskAttemptTimeline: (id: number) => request<{ attempts: Attempt[]; budgetBase: number; total: number }>('GET', `/api/tasks/${id}/attempts/timeline`),
  /** Ticket-wide chronological lifecycle audit projection. */
  taskTimeline: (id: number) => request<{ events: TicketTimelineEvent[]; total: number }>('GET', `/api/tasks/${id}/timeline`),
  taskUsage: (id: number) =>
    request<AttemptUsage & { cost: Cost | null; attemptCount: number }>('GET', `/api/tasks/${id}/usage`),
  attempt: (id: number) => request<AttemptSummary>('GET', `/api/attempts/${id}`),
  /** The Task's current (latest) Attempt — the follow-forward read for pollers. */
  currentAttempt: (taskId: number) => request<AttemptSummary>('GET', `/api/tasks/${taskId}/attempts/current`),
  attemptEvents: (id: number) => request<{ events: AttemptEvent[]; total: number }>('GET', `/api/attempts/${id}/events`),
  attemptLog: (id: number) =>
    request<{ status: 'available'; events: AttemptLogEvent[]; liveCursor: number } | { status: 'unavailable'; liveCursor: number }>('GET', `/api/attempts/${id}/log`),
  attemptGuardrailEvents: (id: number) =>
    request<{ guardrailEvents: GuardrailEvent[]; total: number }>('GET', `/api/attempts/${id}/guardrail-events`),
  attemptVerificationAttempts: (id: number) =>
    request<{ verificationAttempts: VerificationAttempt[]; verifierStatuses: VerifierStatus[]; total: number }>('GET', `/api/attempts/${id}/verification-attempts`),
  verificationAttempt: (id: number) =>
    request<{ output: string; summary: string; hasTranscript: boolean }>('GET', `/api/verification-attempts/${id}`),
  criticLog: (attemptId: number) =>
    request<{ status: 'available'; events: AttemptLogEvent[]; liveCursor: number } | { status: 'unavailable'; liveCursor: number }>(
      'GET',
      `/api/verification-attempts/${attemptId}/log`,
    ),
  attemptDiff: (id: number) =>
    request<{ branch: string | null; baseBranch: string | null; stat: string | null }>(
      'GET',
      `/api/attempts/${id}/diff`,
    ),
  attemptDiffFiles: (id: number) => request<{ files: DiffFile[]; total: number }>('GET', `/api/attempts/${id}/diff/files`),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/change-password', { currentPassword, newPassword }),

  removePassword: (currentPassword: string) =>
    request<{ ok: true }>('DELETE', '/api/auth/password', { currentPassword }),
  conversations: (workspaceId?: number) =>
    request<{ conversations: Conversation[]; total: number }>(
      'GET',
      workspaceId ? `/api/conversations?workspaceId=${workspaceId}` : '/api/conversations',
    ),
  conversation: (id: number) => request<Conversation>('GET', `/api/conversations/${id}`),
  createConversation: (input: { workspaceId?: number; harness?: string; model?: string; workingDir?: string }) =>
    request<Conversation>('POST', '/api/conversations', input),
  // title: null clears an operator-set title, falling back to the one
  // derived from the first Turn.
  renameConversation: (id: number, title: string | null) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, { title }),
  deleteConversation: (id: number) => request<{ ok: true }>('DELETE', `/api/conversations/${id}`),
  conversationEvents: (id: number) =>
    request<{ events: ConversationEvent[]; total: number }>('GET', `/api/conversations/${id}/events`),
  // `queued: true` means a Turn was already
  // running server-side and this message was enqueued as the next Turn
  // rather than started immediately.
  sendTurn: (id: number, text: string) =>
    request<{ ok: true; queued: boolean }>('POST', `/api/conversations/${id}/turns`, { text }),
  endConversation: (id: number) => request<Conversation>('POST', `/api/conversations/${id}/end`),
  // Cancels the in-flight Turn (ACP session/cancel); a non-empty `text`
  // becomes the next Turn, an empty/omitted one just stops it.
  // `text` is included in the body only when non-empty, mirroring
  // answerPermission's optional `remember` below.
  interrupt: (id: number, text?: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/interrupt`, text ? { text } : {}),
  // remember is omitted from the body entirely unless
  // true — the escalation is opt-in, so the common one-off answer stays a
  // plain { optionId } post exactly as before.
  answerPermission: (conversationId: number, reqId: string, optionId: string, remember?: boolean) =>
    request<{ ok: true }>(
      'POST',
      `/api/conversations/${conversationId}/permissions/${reqId}`,
      remember ? { optionId, remember } : { optionId },
    ),
  permissionRules: () => request<{ rules: PermissionRule[]; total: number }>('GET', '/api/permission-rules'),
  deletePermissionRule: (id: number) => request<unknown>('DELETE', `/api/permission-rules/${id}`),
  channels: () => request<{ channels: Channel[]; total: number }>('GET', '/api/channels'),
  createChannel: (input: { name: string; type: Channel['type']; config: Record<string, unknown> }) =>
    request<Channel>('POST', '/api/channels', input),
  updateChannel: (id: number, patch: { events: string[] }) =>
    request<Channel>('PATCH', `/api/channels/${id}`, patch),
  deleteChannel: (id: number) => request<unknown>('DELETE', `/api/channels/${id}`),

  // Paginated on the shared envelope: pass `limit`/`offset`
  // to page, `q` to substring-search the Epic title; omit `limit` for the whole list.
  epics: (workspaceId: number, { limit, offset, q }: { limit?: number; offset?: number; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    if (q) params.set('q', q);
    const query = params.toString();
    const base = `/api/workspaces/${workspaceId}/epics`;
    return request<{ epics: Epic[]; total: number }>('GET', query ? `${base}?${query}` : base);
  },
  epic: (workspaceId: number, epicRef: number) =>
    request<Epic>('GET', `/api/workspaces/${workspaceId}/epics/${epicRef}`),
  forceIntegrateEpic: (workspaceId: number, epicRef: number) =>
    request<EpicIntegrateOutcome>('POST', `/api/workspaces/${workspaceId}/epics/${epicRef}/force-integrate`),
  epicDiffFiles: (workspaceId: number, epicRef: number) =>
    request<{ files: DiffFile[]; total: number }>('GET', `/api/workspaces/${workspaceId}/epics/${epicRef}/diff/files`),

  // Derived Map rollup, paginated on the shared envelope
  // `workspaceId` scopes to one board, `limit`/`offset`
  // page, `q` substring-searches the Map title; omit `limit` for the whole list.
  maps: ({ workspaceId, limit, offset, q }: { workspaceId?: number; limit?: number; offset?: number; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (workspaceId !== undefined) params.set('workspaceId', String(workspaceId));
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    if (q) params.set('q', q);
    const query = params.toString();
    return request<{ maps: MapRollup[]; total: number }>('GET', query ? `/api/maps?${query}` : '/api/maps');
  },
};
