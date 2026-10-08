import type { TrackerRef } from './types.js';
import type { PromptFragmentOverrides } from '../../src/domain/prompt-fragments.js';
import type {
  Attempt,
  ActivityProcess,
  AgentMessageThread,
  AppConfig,
  ExportDestinationTestResult,
  ConfigLayers,
  AttemptUsage,
  BudgetGuardrail,
  Channel,
  ContinuationPreview,
  Conversation,
  ConversationEvent,
  ElicitationAnswer,
  Cost,
  DiffFile,
  FsListing,
  GitStatusEntry,
  WorkspaceFile,
  WorkspaceFileEntry,
  WorkspaceFileListing,
  GuardrailEvent,
  MapRollup,
  PermissionRule,
  AttemptSummary,
  AttemptEvent,
  EpicAttempt,
  AttemptLogEvent,
  Notification,
  Task,
  TicketTimelineEvent,
  VerificationAttempt,
  CommandOverlayEntry,
  TaskCriticOverlayEntry,
  EpicCriticOverlayEntry,
  RoutingLabelOverlayEntry,
  VerifierStatus,
  Workspace,
  TrackerKindInfo,
  TrackerDetection,
  VerifyResult,
  UpdateState,
  HarnessProvider,
  DiscoveredHarnessModel,
  TimelineResponse,
  TaskExportStatus,
  TaskExportAgainResult,
  ExportState,
} from './types.js';
import type { Epic, EpicIntegrateOutcome } from './epic-model.js';
import type { Stats } from './stats-model.js';
import type { OperationForest } from './operations-model.js';
import type { WorktreeInventoryEntry } from './worktree-inventory-model.js';

/** Where a Resolved Prompt is archived: an Attempt by id, or an Epic's Attempt by number (an Epic may have no Attempt row). */
export type ResolvedPromptOwner = { attemptId: number } | { workspaceId: number; epicRef: TrackerRef; attempt: number };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null,
    public errorId: string | null = null,
  ) {
    super(message);
  }
}

const sessionLostListeners = new Set<() => void>();

/** Called when the server stops accepting this tab's session (e.g. it restarted); returns an unsubscribe. */
export function onSessionLost(listener: () => void): () => void {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

function notifySessionLost(): void {
  sessionLostListeners.forEach((listener) => listener());
}

/**
 * Browsers hide why a WebSocket upgrade failed, so a socket that never opened asks
 * the public `/api/auth/me` whether the session is still valid. Network errors are
 * ignored: an unreachable server is a restart, not a lost session.
 */
export async function reportIfSessionLost(): Promise<void> {
  try {
    const res = await fetch('/api/auth/me');
    const me = (await res.json()) as { authenticated: boolean; passwordConfigured: boolean };
    if (me.passwordConfigured && !me.authenticated) notifySessionLost();
  } catch {
  }
}

async function send(method: string, path: string, body?: unknown): Promise<{ res: Response; text: string }> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  // `/api/auth/*` 401s mean a wrong password typed into a form, not a lost session.
  if (res.status === 401 && !path.startsWith('/api/auth/')) notifySessionLost();
  return { res, text: await res.text() };
}

function failure(method: string, path: string, res: Response, json: unknown): ApiError {
  const fallback = `${method} ${path} failed (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`;
  const envelope = json && typeof json === 'object' && 'error' in json ? (json as { error?: { message?: string; code?: string; id?: string } }).error : undefined;
  const message = envelope?.message ?? fallback;
  return new ApiError(res.status, envelope?.id ? `${message} (ref ${envelope.id})` : message, envelope?.code ?? null, envelope?.id ?? null);
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { res, text } = await send(method, path, body);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — a proxy or the server itself returned plain text/HTML. Never
    // surface that raw body to the operator.
    throw new ApiError(res.status, `${method} ${path} failed (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`);
  }
  if (!res.ok) throw failure(method, path, res, json);
  if (json === null && res.status !== 204) {
    throw new ApiError(res.status, `Empty response from ${method} ${path}`);
  }
  return json as T;
}

async function requestText(path: string, unavailable = 'Full output unavailable'): Promise<string> {
  const { res, text } = await send('GET', path);
  if (!res.ok) throw new ApiError(res.status, `${unavailable} (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`);
  return text;
}

export const api = {
  scheduledJobs: () => request<unknown>('GET', '/api/scheduled-jobs'),
  operations: () => request<OperationForest>('GET', '/api/operations'),
  trackerKinds: () => request<{ kinds: TrackerKindInfo[] }>('GET', '/api/tracker-kinds'),
  trackerDetection: (workspaceId: number) => request<TrackerDetection>('GET', `/api/workspaces/${workspaceId}/tracker-detection`),
  verifyTracker: (workspaceId: number) => request<VerifyResult>('POST', `/api/workspaces/${workspaceId}/tracker/verify`),
  verifyRepository: (workspaceId: number) => request<VerifyResult>('POST', `/api/workspaces/${workspaceId}/repository/verify`),
  secretStatus: (workspaceId: number, name: string) =>
    request<{ name: string; set: boolean }>('GET', `/api/workspaces/${workspaceId}/secrets/${encodeURIComponent(name)}`),
  setSecret: (workspaceId: number, name: string, value: string) =>
    request<unknown>('PUT', `/api/workspaces/${workspaceId}/secrets/${encodeURIComponent(name)}`, { value }),
  clearSecret: (workspaceId: number, name: string) =>
    request<unknown>('DELETE', `/api/workspaces/${workspaceId}/secrets/${encodeURIComponent(name)}`),
  harnessProviders: (harness: string) => request<{ providers: HarnessProvider[] }>('GET', `/api/harnesses/${encodeURIComponent(harness)}/providers`),
  harnessModels: (harness: string, provider: string) => request<{ models: DiscoveredHarnessModel[] }>('GET', `/api/harnesses/${encodeURIComponent(harness)}/models?provider=${encodeURIComponent(provider)}`),
  config: () => request<AppConfig>('GET', '/api/config'),
  globalPause: () => request<{ paused: boolean }>('GET', '/api/global-pause'),
  updateState: () => request<UpdateState>('GET', '/api/update'),
  armUpdate: () => request<UpdateState>('POST', '/api/update/arm'),
  cancelUpdate: () => request<UpdateState>('DELETE', '/api/update/arm'),
  dismissUpdate: () => request<UpdateState>('POST', '/api/update/dismiss'),
  checkUpdate: () => request<UpdateState>('POST', '/api/update/check'),
  pauseGlobal: () => request<{ paused: boolean }>('POST', '/api/global-pause'),
  resumeGlobal: () => request<{ paused: boolean }>('DELETE', '/api/global-pause'),
  configLayers: () => request<ConfigLayers>('GET', '/api/config/layers'),
  updateConfig: (patch: object) => request<AppConfig>('PATCH', '/api/config', patch),
  testExportDestination: (body: { workspaceId: number | null; destination: 'directory' | 's3' }) =>
    request<ExportDestinationTestResult>('POST', '/api/export/test-destination', body),
  replaceConfig: (config: AppConfig) => request<AppConfig>('PUT', '/api/config', config),
  revertConfig: () => request<AppConfig>('DELETE', '/api/config/overrides'),
  /** `open` is an explicit board optimization. Omit it for full task history.
   * The response is the shared paginated envelope: the page under
   * `tasks` plus the filtered `total`. Pass `limit`/`offset` to page through it;
   * omit `limit` for the whole filtered list. */
  tasks: ({ workspaceId, state, parent, limit, offset }: { workspaceId?: number; state?: 'open'; parent?: TrackerRef; limit?: number; offset?: number } = {}) => {
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
  notifications: ({ workspaceId, limit, before }: { workspaceId?: number; limit?: number; before?: number } = {}) => {
    const params = new URLSearchParams();
    if (workspaceId !== undefined) params.set('workspaceId', String(workspaceId));
    if (limit !== undefined) params.set('limit', String(limit));
    if (before !== undefined) params.set('before', String(before));
    const query = params.toString();
    return request<{ items: Notification[]; unreadCount: number }>('GET', query ? `/api/notifications?${query}` : '/api/notifications');
  },
  markNotificationRead: (id: number) => request<{ notification: Notification }>('POST', `/api/notifications/${id}/read`),
  markAllNotificationsRead: (workspaceId?: number) =>
    request<{ updated: number }>('POST', '/api/notifications/read-all', workspaceId === undefined ? {} : { workspaceId }),
  stats: (from: number, to: number, workspaceId?: number) => {
    const query = new URLSearchParams({ from: String(from), to: String(to) });
    if (workspaceId !== undefined) query.set('workspaceId', String(workspaceId));
    return request<Stats>('GET', `/api/stats?${query}`);
  },
  activity: (workspaceId?: number) => request<{ processes: ActivityProcess[]; agentMessagesEnabledInAnyWorkspace: boolean }>('GET', workspaceId === undefined ? '/api/activity' : `/api/activity?workspaceId=${workspaceId}`),
  agentMessageThreads: (params: { workspaceId?: number; epicId?: TrackerRef; taskId?: number; live?: boolean; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const qs = query.toString();
    return request<{ threads: AgentMessageThread[]; total: number; totalMessages: number }>('GET', qs ? `/api/agent-messages/threads?${qs}` : '/api/agent-messages/threads');
  },
  timeline: (workspaceId: number | undefined, from: number, to: number) => {
    const query = new URLSearchParams({ from: String(from), to: String(to) });
    if (workspaceId !== undefined) query.set('workspaceId', String(workspaceId));
    return request<TimelineResponse>('GET', `/api/timeline?${query}`);
  },
  epicStats: (epicRef: TrackerRef, workspaceId: number) =>
    request<Stats>('GET', `/api/epics/${epicRef}/stats?workspaceId=${workspaceId}`),
  createTask: (input: Partial<Task> & { prompt: string; state?: 'draft' | 'ready' }) =>
    request<Task>('POST', '/api/tasks', input),
  // Lazy directory picker: one level deep per call; an omitted
  // path starts at the server user's home. Operator-only (full-scope session).
  browseFs: (path?: string) =>
    request<FsListing>('GET', path ? `/api/fs?path=${encodeURIComponent(path)}` : '/api/fs'),
  workspaceFiles: (workspaceId: number, path = '', offset = 0) => {
    const query = new URLSearchParams({ workspaceId: String(workspaceId), path, offset: String(offset) });
    return request<WorkspaceFileListing>('GET', `/api/fs/tree?${query}`);
  },
  workspaceFile: (workspaceId: number, path: string) =>
    request<WorkspaceFile>('GET', `/api/fs/file?workspaceId=${workspaceId}&path=${encodeURIComponent(path)}`),
  workspaceRawUrl: (workspaceId: number, path: string) =>
    `/api/fs/raw?workspaceId=${workspaceId}&path=${encodeURIComponent(path)}`,
  saveWorkspaceFile: (workspaceId: number, path: string, text: string) =>
    request<WorkspaceFile>('PUT', `/api/fs/file?workspaceId=${workspaceId}&path=${encodeURIComponent(path)}`, { text }),
  createWorkspaceEntry: (workspaceId: number, path: string, type: 'file' | 'directory') =>
    request<WorkspaceFileEntry>('POST', '/api/fs/create', { workspaceId, path, type }),
  moveWorkspaceEntry: (workspaceId: number, from: string, to: string) =>
    request<WorkspaceFileEntry>('POST', '/api/fs/move', { workspaceId, from, to }),
  deleteWorkspaceEntry: (workspaceId: number, path: string) =>
    request<{ ok: true }>('POST', '/api/fs/delete', { workspaceId, path }),
  gitStatus: (workspaceId: number) => request<{ entries: GitStatusEntry[] }>('GET', `/api/git/status?workspaceId=${workspaceId}`),
  stageGitPaths: (workspaceId: number, paths: string[]) => request<{ ok: true }>('POST', '/api/git/stage', { workspaceId, paths }),
  unstageGitPaths: (workspaceId: number, paths: string[]) => request<{ ok: true }>('POST', '/api/git/unstage', { workspaceId, paths }),
  discardGitPaths: (workspaceId: number, paths: string[]) => request<{ ok: true }>('POST', '/api/git/discard', { workspaceId, paths }),
  commitGitChanges: (workspaceId: number, message: string) => request<{ ok: true }>('POST', '/api/git/commit', { workspaceId, message }),
  gitFileDiff: (workspaceId: number, path: string) => request<{ file: DiffFile | null }>('GET', `/api/git/diff?workspaceId=${workspaceId}&path=${encodeURIComponent(path)}`),
  worktrees: ({ workspaceId, limit, offset }: { workspaceId?: number; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (workspaceId !== undefined) params.set('workspaceId', String(workspaceId));
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const query = params.toString();
    return request<{ worktrees: WorktreeInventoryEntry[]; total: number; reconciledAt: number | null }>('GET', query ? `/api/worktrees?${query}` : '/api/worktrees');
  },
  dirtyWorktreeFiles: (id: string, workspaceId?: number) => request<{ files: string[] }>('GET', `/api/worktrees/${encodeURIComponent(id)}/dirty-files${workspaceId === undefined ? '' : `?workspaceId=${workspaceId}`}`),
  cleanupWorktree: (id: string, workspaceId?: number) => request<{ removed: boolean }>('POST', `/api/worktrees/${encodeURIComponent(id)}/cleanup${workspaceId === undefined ? '' : `?workspaceId=${workspaceId}`}`),
  reconcileWorktrees: (workspaceId?: number) => request<{ removed: number; recreated: number; flagged: number }>('POST', `/api/operations/reconcile${workspaceId === undefined ? '' : `?workspaceId=${workspaceId}`}`),
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
      color?: string;
      trackerEnabled?: boolean;
      trackerPollIntervalSeconds?: number;
      excludedDirectories?: string[] | null;
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
      agentMessagesEnabled?: boolean | null;
      agentMessagesSendCap?: number | null;
      contextReuseTokenLimit?: number | null;
      taskPreMergeCommands?: CommandOverlayEntry[] | null;
      taskPreMergeCritics?: TaskCriticOverlayEntry[] | null;
      taskPostMergeCommands?: CommandOverlayEntry[] | null;
      taskPostMergeCritics?: TaskCriticOverlayEntry[] | null;
      epicPreMergeCommands?: CommandOverlayEntry[] | null;
      epicPreMergeCritics?: EpicCriticOverlayEntry[] | null;
      routingLabels?: RoutingLabelOverlayEntry[] | null;
      guardrailBudget?: BudgetGuardrail | null;
      guardrailProgress?: boolean | null;
      exportEnabled?: boolean | null;
      exportDirectoryPath?: string | null;
      exportS3Endpoint?: string | null;
      exportS3Region?: string | null;
      exportS3Bucket?: string | null;
      exportS3Prefix?: string | null;
      exportS3ForcePathStyle?: boolean | null;
      exportS3AccessKeyId?: string | null;
      exportS3SecretAccessKey?: string | null;
      exportRedactPatterns?: { id: string; regex: string }[] | null;
      exportIncludeStates?: ExportState[] | null;
      configuredTracker?: Workspace['configuredTracker'];
      codeRepository?: Workspace['codeRepository'];
      triageLabels?: Workspace['triageLabels'];
      archiveRetentionDays?: number | null;
      archiveRetentionMaxTotalMB?: number | null;
      toolTimeoutMinutes?: number | null;
      drivePrompt?: string | null;
      driveUnattendedReminder?: string | null;
      driveContinuePrompt?: string | null;
      driveMergeFate?: 'auto-merge' | 'open-PR' | 'artifact' | null;
      driveContinueAttempts?: number | null;
      taskPrompt?: string | null;
    } & Partial<PromptFragmentOverrides>,
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
  pauseTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/pause`),
  resumeTask: (id: number, continuation?: 'full' | 'condensed') =>
    request<Task>('POST', `/api/tasks/${id}/resume`, continuation ? { continuation } : undefined),
  /** Operator override: stop a working task's agent and settle it done, skipping verification. */
  completeTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/complete`),
  /** Steer a running task: queue a message for its active run, delivered at the next turn boundary. */
  steerTask: (id: number, text: string) =>
    request<{ ok: true }>('POST', `/api/tasks/${id}/steer`, { text }),
  /** Extend a working task's wall-clock time guardrail by `minutes`. */
  extendGuardrail: (id: number, minutes: number) =>
    request<Task>('POST', `/api/tasks/${id}/extend-guardrail`, { minutes }),
  uncancelTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/uncancel`),
  addDependency: (id: number, dependsOnId: number) =>
    request<Task>('POST', `/api/tasks/${id}/dependencies`, { dependsOnId }),
  removeDependency: (id: number, depId: number) =>
    request<Task>('DELETE', `/api/tasks/${id}/dependencies/${depId}`),
  continuationPreview: (id: number) => request<ContinuationPreview>('GET', `/api/tasks/${id}/continuation`),
  retryEpic: (workspaceId: number, epicRef: TrackerRef, guidance: string, continuation: 'continue' | 'fresh') =>
    request<EpicIntegrateOutcome>('POST', `/api/workspaces/${workspaceId}/epics/${epicRef}/retry`, { guidance, continuation }),
  // The three escalation actions, escalated tickets only.
  // Accept merges the candidate as-is — the operator's judgement is the gate,
  // no verification runs.
  acceptTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/accept`),
  retryTask: (
    id: number,
    body: { guidance: string; startNow?: boolean; reuseSession?: boolean; harness?: string; model?: string },
  ) => request<Task>('POST', `/api/tasks/${id}/retry`, body),
  closeTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/close`),
  // Hard-delete: cascades the Task's Attempts/history and
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
  taskExport: (id: number) => request<TaskExportStatus>('GET', `/api/tasks/${id}/export`),
  exportTaskAgain: (id: number) => request<TaskExportAgainResult>('POST', `/api/tasks/${id}/export`),
  taskExportDownloadUrl: (id: number) => `/api/tasks/${id}/export/download`,
  epicExport: (workspaceId: number, epicRef: TrackerRef) => request<TaskExportStatus>('GET', `/api/workspaces/${workspaceId}/epics/${epicRef}/export`),
  exportEpicAgain: (workspaceId: number, epicRef: TrackerRef) => request<TaskExportAgainResult>('POST', `/api/workspaces/${workspaceId}/epics/${epicRef}/export`),
  epicExportDownloadUrl: (workspaceId: number, epicRef: TrackerRef) => `/api/workspaces/${workspaceId}/epics/${epicRef}/export/download`,
  taskUsage: (id: number) =>
    request<AttemptUsage & { cost: Cost | null; attemptCount: number }>('GET', `/api/tasks/${id}/usage`),
  attempt: (id: number) => request<AttemptSummary>('GET', `/api/attempts/${id}`),
  /** The Task's current (latest) Attempt — the follow-forward read for pollers. */
  currentAttempt: (taskId: number) => request<AttemptSummary>('GET', `/api/tasks/${taskId}/attempts/current`),
  attemptEvents: (id: number) => request<{ events: AttemptEvent[]; total: number }>('GET', `/api/attempts/${id}/events`),
  attemptLog: (id: number) =>
    request<{ status: 'available'; events: AttemptLogEvent[]; liveCursor: number; fromArchive?: boolean } | { status: 'unavailable'; liveCursor: number }>('GET', `/api/attempts/${id}/log`),
  attemptGuardrailEvents: (id: number) =>
    request<{ guardrailEvents: GuardrailEvent[]; total: number }>('GET', `/api/attempts/${id}/guardrail-events`),
  attemptVerificationAttempts: (id: number) =>
    request<{ verificationAttempts: VerificationAttempt[]; verifierStatuses: VerifierStatus[]; total: number }>('GET', `/api/attempts/${id}/verification-attempts`),
  verificationAttempt: (id: number) =>
    request<{ output: string; summary: string; hasTranscript: boolean }>('GET', `/api/verification-attempts/${id}`),
  verificationOutputUrl: (id: number) => `/api/verification-attempts/${id}/output`,
  resolvedPrompt: (owner: ResolvedPromptOwner, locator: string, index?: number) => {
    const at = `locator=${encodeURIComponent(locator)}${index === undefined ? '' : `&index=${index}`}`;
    return requestText(
      'attemptId' in owner
        ? `/api/attempts/${owner.attemptId}/resolved-prompt?${at}`
        : `/api/workspaces/${owner.workspaceId}/epics/${owner.epicRef}/resolved-prompt?attempt=${owner.attempt}&${at}`,
      'Sent prompt unavailable',
    );
  },
  verificationFullOutput: (id: number) => requestText(`/api/verification-attempts/${id}/output`),
  criticLog: (attemptId: number) =>
    request<{ status: 'available'; events: AttemptLogEvent[]; liveCursor: number; fromArchive?: boolean } | { status: 'unavailable'; liveCursor: number }>(
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
  createConversation: (input: { workspaceId?: number; harness?: string; model?: string; workingDir?: string; permissionMode?: 'ask' | 'automatic' }) =>
    request<Conversation>('POST', '/api/conversations', input),
  // title: null clears an operator-set title, falling back to the one
  // derived from the first Turn.
  renameConversation: (id: number, title: string | null) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, { title }),
  setConversationPermissionMode: (id: number, permissionMode: 'ask' | 'automatic') =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, { permissionMode }),
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
  answerElicitation: (conversationId: number, reqId: string, answer: ElicitationAnswer) =>
    request<{ ok: true }>('POST', `/api/conversations/${conversationId}/elicitations/${reqId}`, answer),
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
  epic: (workspaceId: number, epicRef: TrackerRef) =>
    request<Epic>('GET', `/api/workspaces/${workspaceId}/epics/${epicRef}`),
  attemptResolvedPrompts: (attemptId: number, locator: string) =>
    request<{ prompts: string[] }>('GET', `/api/attempts/${attemptId}/resolved-prompt?locator=${encodeURIComponent(locator)}&segments=true`).then((r) => r.prompts),
  epicAttempts: (workspaceId: number, epicRef: TrackerRef) =>
    request<{ attempts: EpicAttempt[] }>('GET', `/api/workspaces/${workspaceId}/epics/${epicRef}/attempts`),
  epicDiffFiles: (workspaceId: number, epicRef: TrackerRef) =>
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
