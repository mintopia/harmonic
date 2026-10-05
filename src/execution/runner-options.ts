import type { TrackerRef } from '../tracker/adapter.js';
import type { TaskArchive } from '../archive/task-archive.js';
import type { PromptFragmentOverrideKey } from '../domain/prompt-fragments.js';
import type { AgentMessageStore } from '../domain/agent-messages.js';
import type { AutoDrive } from './auto-drive.js';
import type { TailerCadence } from './live-usage-tailer.js';
import type { GitCircuitBreaker } from './git-failure.js';
import type { PostMergeHook } from './branch-merge.js';
import type { TaskRow, AttemptRow, WorkspaceRow } from '../db/schema.js';
import type { SessionRetirementHook } from '../domain/session-retirement-coordinator.js';
import type { PersistedAttemptEvent } from '../domain/attempts.js';
import type { LiveAttemptEvent } from './live-events.js';
import type { AttemptUsageSnapshot } from './usage.js';
import { type CriticHarnessDrive } from '../verification/critic.js';
import type { CommandSpawn } from '../verification/command-verifier.js';
import type { SpawnProcessGroup } from './process-groups.js';
import type { FireAndForget } from '../error-handling.js';

export interface RunnerEvents {
  /** Fired after every run event is persisted (live streaming hook). */
  onAttemptEvent?: (event: PersistedAttemptEvent) => void;
  /** ACP session updates are transient: streamed to clients, never persisted. */
  onAttemptLogEvent?: (event: LiveAttemptEvent) => void;
  /** The critic turn's ACP session updates, on their own channel (same shape as
   * `onAttemptLogEvent`) so a running critic streams as its own chat. */
  onCriticLogEvent?: (event: LiveAttemptEvent) => void;
  /** Fired whenever a run reaches a terminal state. */
  onAttemptFinished?: (run: AttemptRow) => void;
  /** Fired ~1s while a run tails its native log. */
  onAttemptUsage?: (payload: { attemptId: number; snapshot: AttemptUsageSnapshot }) => void;
  /** Fired when a Step transitions within a still-running Attempt, so the
   * Task-detail timeline follows the live phase (the Attempt row is unchanged,
   * so `onAttemptFinished` never covers these). */
  onStepChanged?: (taskId: number) => void;
  /** Fired after each Epic integration-merge step is persisted, so the Epic's
   * merge progress can follow live (Epics have no Attempt row to stream). */
  onEpicMergeStep?: (payload: { workspaceId: number; epicRef: TrackerRef }) => void;
  /** Fired after a Task-level lifecycle event (no owning Attempt) is
   * persisted, so the ticket timeline can follow live. */
  onTaskEvent?: (taskId: number) => void;
}

/** The minimum {@link TaskEventStore} surface a git-visibility writer needs to
 * append a row with no owning Attempt. */
export interface TaskEventAppender {
  appendEvent(taskId: number, payload: unknown): Promise<unknown>;
}

export interface RunnerOptions {
  /** Held Agent Messages injected at Attempt start. */
  agentMessages?: AgentMessageStore;
  archive?: TaskArchive;
  isGloballyPaused?: () => boolean;
  onGloballyPaused?: (taskId: number) => Promise<void>;
  events?: RunnerEvents;
  /** Where temporary worktrees live; per-run subdirectories. */
  worktreesDir?: string;
  /** Mints/revokes the per-Attempt scoped API key injected into the harness. */
  keys?: {
    mint: (attemptId: number) => Promise<string>;
    revoke: (attemptId: number) => void | Promise<void>;
  };
  /** Auto-drive collaborator for mirrored Tasks; absent on a native-only server. */
  autoDrive?: AutoDrive;
  /** Resolves a Task's ticket URL for the critic's `{url}` interpolation token;
   * absent → `{url}` resolves to empty. */
  urlFor?: (task: TaskRow) => string | null;
  /** Push/persist cadence for the live-usage tailer; defaults to ~1s/~10s. */
  tailerCadence?: TailerCadence;
  /** Spend-Guardrail poll + unmeasurable-grace cadence; defaults to ~1s poll / 60s grace. */
  spendGuardrail?: { pollMs?: number; graceMs?: number } | undefined;
  /** Resolves a Task's Workspace row for the Guardrail snapshot;
   * absent → the snapshot resolves against global defaults only. */
  getWorkspace?: (
    workspaceId: number | null,
  ) => Promise<
    | (Pick<
        WorkspaceRow,
        | 'guardrailBudget'
        | 'guardrailProgress'
        | 'toolTimeoutMinutes'
        | 'taskPreMergeCommands'
        | 'taskPreMergeCritics'
        | 'taskPostMergeCommands'
        | 'taskPostMergeCritics'
        | 'epicPreMergeCommands'
        | 'epicPreMergeCritics'
        | 'maxAttempts'
        | 'contextReuseTokenLimit'
        | 'taskPrompt'
        | 'pauseMessage'
        | PromptFragmentOverrideKey
        | 'agentMessagesEnabled'
        | 'driveCommitNudge'
        | 'mergeConflictPrompt'
        | 'mergeEpicConflictPrompt'
        | 'mergeEpicRefreshPrompt'
        | 'verifyEpicResolveSuffix'
      > &
        Partial<Pick<WorkspaceRow, 'workingDir'>>)
    | undefined
  >;
  /** The agent-critic drive; the real one spawns the builder's configured harness as a contained read-only reviewer. */
  criticDrive: CriticHarnessDrive;
  commandSpawn: CommandSpawn;
  spawnProcessGroup: SpawnProcessGroup;
  fireAndForget: FireAndForget;
  /** Session retirement hook; absent → Sessions are never retired. */
  sessionRetirement?: SessionRetirementHook;
  onFailedAttemptRequeued?: (task: TaskRow, reason: string) => void;
  onTaskMerged?: (task: TaskRow) => void;
  /** Per-context git circuit breaker, shared with the Auto-Runner (which must
   * be given the SAME instance). Absent → no breaker. */
  gitBreaker?: GitCircuitBreaker;
  /** Start-funnel gate for parallel-Epic members: true while a Task's
   * integration base isn't ready to fork from. {@link Runner.beginRun} refuses
   * to spawn such an Attempt (a `DomainError`). Absent → not gated. */
  epicBaseNotReady?: (task: TaskRow) => boolean | Promise<boolean>;
  postMerge?: PostMergeHook;
  /** Task-level lifecycle log for a git side effect with no owning Attempt
   * (an operator-Close cleanup on a Task that never spawned one). Absent →
   * that cleanup still happens, just unobserved. */
  taskEvents?: TaskEventAppender;
}

export interface Workspace {
  cwd: string;
  env: Record<string, string>;
  worktree?: { repoDir: string; path: string };
  baseRev?: string;
  startDirty?: boolean;
}
