import type {
  Attempt,
  AppConfig,
  BudgetGuardrail,
  Channel,
  ContinuationPreview,
  Conversation,
  ConversationEvent,
  Cost,
  DiffFile,
  FsListing,
  GuardrailEvent,
  PermissionRule,
  Run,
  RunEvent,
  RunLogEvent,
  Task,
  TicketTimelineEvent,
  VerificationAttempt,
  VerificationCommand,
  VerificationCritic,
  VerifierOff,
  Workspace,
} from './types.js';
import type { Epic, EpicLandOutcome } from './epic-model.js';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A Work Context lease's queue diagnostics (issue #125): the operator-only
 * `/api/leases` readout backing the Activity view's leases panel. `state`
 * `suspect` means the coordinator's heartbeat/TTL sweep flagged the owner as
 * possibly dead; `held` is a live, heartbeating owner. `longestWaitMs`/
 * `waitingTaskCount` describe the queue of ready Tasks blocked behind this
 * context, not the lease's own age.
 */
export interface LeaseDiagnostic {
  key: string;
  state: 'held' | 'suspect';
  phase: string;
  ownerRunId: number;
  ownerTaskId: number | null;
  ownerTaskTitle: string | null;
  ownerTaskState: string | null;
  acquiredAt: number;
  heartbeat: number | null;
  expiry: number | null;
  /** Longest-waiting ready Task blocked on this context, in ms; null when none are waiting. */
  longestWaitMs: number | null;
  waitingTaskCount: number;
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
  // A successful response with no JSON body is a truncated/transport failure
  // (e.g. a reverse-proxy hiccup), not a real value — every endpoint here
  // returns a body on success (even deletes reply `{ ok: true }`). Returning
  // the bare `null` would surface far away as a cryptic destructure crash
  // ("null has no properties" in Firefox) the moment a caller reads a field
  // off it; fail honestly and locally instead. A genuine 204 No Content is
  // the one legitimate empty body.
  if (json === null && res.status !== 204) {
    throw new ApiError(res.status, `Empty response from ${method} ${path}`);
  }
  return json as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  updateConfig: (patch: object) => request<AppConfig>('PATCH', '/api/config', patch),
  replaceConfig: (config: AppConfig) => request<AppConfig>('PUT', '/api/config', config),
  /** `open` is an explicit board optimization. Omit it for full task history. */
  tasks: ({ workspaceId, state }: { workspaceId?: number; state?: 'open' } = {}) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', String(workspaceId));
    if (state) params.set('state', state);
    const query = params.toString();
    return request<{ tasks: Task[] }>('GET', query ? `/api/tasks?${query}` : '/api/tasks');
  },
  task: (id: number) => request<Task>('GET', `/api/tasks/${id}`),
  createTask: (input: Partial<Task> & { prompt: string; state?: 'draft' | 'ready' }) =>
    request<Task>('POST', '/api/tasks', input),
  // Lazy directory picker (issue #67): one level deep per call; an omitted
  // path starts at the server user's home. Operator-only (full-scope session).
  browseFs: (path?: string) =>
    request<FsListing>('GET', path ? `/api/fs?path=${encodeURIComponent(path)}` : '/api/fs'),
  workspaces: () => request<{ workspaces: Workspace[] }>('GET', '/api/workspaces'),
  createWorkspace: (input: { name: string; workingDir: string }) =>
    request<Workspace>('POST', '/api/workspaces', input),
  // Overridable fields (ADR-0012, issue #64) accept `null` to clear an override
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
      maxConcurrentRuns?: number | null;
      autoRunnerEnabled?: boolean | null;
      verificationCommand?: VerificationCommand | VerifierOff | null;
      verificationCritic?: VerificationCritic | VerifierOff | null;
      guardrailBudget?: BudgetGuardrail | null;
      guardrailProgress?: boolean | null;
    },
  ) => request<Workspace>('PATCH', `/api/workspaces/${id}`, patch),
  // Deletes the Workspace and cascades its board; the server 204s (empty body,
  // handled by request's 204 branch). Deleting the last Workspace is allowed
  // (issue #61) — the app falls to the empty state; a running Task 409s.
  deleteWorkspace: (id: number) => request<null>('DELETE', `/api/workspaces/${id}`),
  // Force an immediate tracker poll (the board's manual refresh) — rescans the
  // repo and mirrors changes now. 409 if the Workspace has tracking disabled.
  refreshTracker: (id: number) => request<{ ok: true }>('POST', `/api/workspaces/${id}/tracker/refresh`),
  // The four Task-default fields (ADR-0012) accept `null` to clear the override
  // back to inherit; other fields keep their non-null Partial<Task> shape.
  updateTask: (
    id: number,
    input: Partial<Omit<Task, 'harness' | 'model' | 'isolationMode' | 'priority'>> & {
      harness?: string | null;
      model?: string | null;
      isolationMode?: 'direct' | 'worktree' | null;
      priority?: 'high' | 'normal' | 'low' | null;
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
  // The continuation preview (issue #170): what the deterministic rule (#311)
  // will do with the task's live Session when the loop resumes — shown in the
  // reject dialog as information, never a choice.
  continuationPreview: (id: number) => request<ContinuationPreview>('GET', `/api/tasks/${id}/continuation`),
  // The three escalation actions (ADR-0041), escalated tickets only.
  acceptTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/accept`),
  rejectTask: (id: number, guidance: string) => request<Task>('POST', `/api/tasks/${id}/reject`, { guidance }),
  closeTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/close`),
  // Hard-delete (issue #162, ADR-0025): cascades the Task's Runs/history and
  // vanishes it from the board/graph via the `task_removed` WS broadcast
  // (App.tsx). 409 if the Task is running (stop it first); 404 if it's
  // already gone.
  deleteTask: (id: number) => request<{ id: number }>('DELETE', `/api/tasks/${id}`),
  runTask: (id: number) => request<Run>('POST', `/api/tasks/${id}/run`),
  taskRuns: (id: number) => request<{ runs: Run[] }>('GET', `/api/tasks/${id}/runs`),
  /** Ordered durable Attempt/Task history for the ticket page. */
  taskAttempts: (id: number) => request<{ attempts: Attempt[]; budgetBase: number }>('GET', `/api/tasks/${id}/attempts`),
  /** Ticket-wide chronological lifecycle audit projection. */
  taskTimeline: (id: number) => request<{ events: TicketTimelineEvent[] }>('GET', `/api/tasks/${id}/timeline`),
  taskUsage: (id: number) =>
    request<{ cost: Cost | null; runCount: number }>('GET', `/api/tasks/${id}/usage`),
  run: (id: number) => request<Run>('GET', `/api/runs/${id}`),
  runEvents: (id: number) => request<{ events: RunEvent[] }>('GET', `/api/runs/${id}/events`),
  runLog: (id: number) =>
    request<{ status: 'available'; events: RunLogEvent[]; liveCursor: number } | { status: 'unavailable'; liveCursor: number }>('GET', `/api/runs/${id}/log`),
  // Guardrail-trip event log for a Run (issue #171): the REST surface over
  // `GuardrailEventStore.list`, mirroring `runEvents`'s shape and 404 behaviour.
  runGuardrailEvents: (id: number) =>
    request<{ guardrailEvents: GuardrailEvent[] }>('GET', `/api/runs/${id}/guardrail-events`),
  // Per-verifier Verification-attempt log for a Run (issue #169, part of
  // #109): the REST surface over the attempts store, mirroring
  // `runGuardrailEvents`'s shape and 404 behaviour.
  runVerificationAttempts: (id: number) =>
    request<{ verificationAttempts: VerificationAttempt[] }>('GET', `/api/runs/${id}/verification-attempts`),
  verificationAttempt: (id: number) =>
    request<{ output: string; summary: string; hasTranscript: boolean }>('GET', `/api/verification-attempts/${id}`),
  // A critic verification attempt's own native session transcript (ADR-0040) —
  // same shape as `runLog`, keyed by attempt id, "unavailable" when no
  // transcript was captured.
  criticLog: (attemptId: number) =>
    request<{ status: 'available'; events: RunLogEvent[]; liveCursor: number } | { status: 'unavailable'; liveCursor: number }>(
      'GET',
      `/api/verification-attempts/${attemptId}/log`,
    ),
  runDiff: (id: number) =>
    request<{ branch: string | null; baseBranch: string | null; stat: string | null }>(
      'GET',
      `/api/runs/${id}/diff`,
    ),
  runDiffFiles: (id: number) => request<{ files: DiffFile[] }>('GET', `/api/runs/${id}/diff/files`),
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

  // Work Context lease diagnostics + operator controls (issue #125):
  // operator-only, 403 for anyone else.
  leases: () => request<{ leases: LeaseDiagnostic[] }>('GET', '/api/leases'),
  /** Hand a held/suspect lease to a chosen Run, superseding its current owner. */
  supersedeLease: (key: string, runId: number) =>
    request<{ ok: true }>('POST', '/api/leases/supersede', { key, runId }),
  /** Force-release a held/suspect lease with no successor. */
  unlockLease: (key: string) => request<{ ok: true }>('POST', '/api/leases/unlock', { key }),

  // Parallel-Epic read model + force-land (issue #167, ADR-0026): operator-scope
  // only, mirroring the force-land allowlist. See epic-model.ts for the DTO shape.
  epics: (workspaceId: number) => request<{ epics: Epic[] }>('GET', `/api/workspaces/${workspaceId}/epics`),
  epic: (workspaceId: number, epicRef: number) =>
    request<Epic>('GET', `/api/workspaces/${workspaceId}/epics/${epicRef}`),
  forceLandEpic: (workspaceId: number, epicRef: number) =>
    request<EpicLandOutcome>('POST', `/api/workspaces/${workspaceId}/epics/${epicRef}/force-land`),
};
