import type { FastifyInstance } from 'fastify';
import type { AppConfig, DeepPartial } from '../config.js';
import { SettingsStore } from './settings-store.js';
import { TaskService } from '../domain/tasks.js';
import { AttemptStore } from '../domain/attempts.js';
import { TaskEventStore } from '../domain/task-events.js';
import { ConversationStore } from '../domain/conversations.js';
import { WorkspaceService } from '../domain/workspaces.js';
import { PermissionRuleStore } from '../domain/permission-rules.js';
import { EscalationService } from '../domain/escalation.js';
import { SessionStore } from '../domain/sessions.js';
import { WorktreeReconciler } from '../domain/worktree-reconciler.js';
import { WorktreeInventory } from '../domain/worktree-inventory.js';
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { Runner } from '../execution/runner.js';
import { ConversationDriver } from '../execution/conversation-driver.js';
import { AutoRunner } from '../execution/auto-runner.js';
import { GlobalPause } from '../execution/global-pause.js';
import { HostLoadSampler } from '../host-load.js';
import { WorkspaceWatcher } from '../domain/workspace-watcher.js';
import { Scheduler, type ScheduledJobRegistration } from '../scheduler/scheduler.js';
import { TrackerPollerManager } from '../tracker/manager.js';
import type { EpicService } from '../tracker/epic-service.js';
import { ChannelService } from '../notifications/channels.js';
import { Notifier } from '../notifications/notifier.js';
import { EventBus } from './bus.js';
import { AuthService } from './auth.js';
import type { DistributionMode } from '../distribution-mode.js';
import { UpdateCheck } from '../upgrade/update-check.js';
import { UpgradeCoordinator } from '../upgrade/upgrade-coordinator.js';
import type { InstallMode } from '../upgrade/install-mode.js';
import type { AsyncDbHandle } from '../db/async.js';
import type { StatsWorkerClient } from '../db/stats-reader.js';
import type { CriticHarnessDrive } from '../verification/critic.js';

export interface AppOptions {
  dataDir: string;
  configOverrides?: DeepPartial<AppConfig> | undefined;
  /** Set/update the operator password at boot; an empty string clears it (ungated). Undefined leaves it untouched. */
  password?: string | undefined;
  /** Test-only Runner cadence overrides; absent uses production defaults. */
  runnerTuning?: { spendGuardrail?: { pollMs?: number; graceMs?: number } } | undefined;
  /** Event-loop stall monitor overrides; `enabled: false` turns the probe off. */
  reliabilityTuning?: { eventLoop?: { enabled?: boolean; probeMs?: number; stallMs?: number } } | undefined;
  /** Test-only critic drive override; absent uses the real ACP critic drive. */
  criticDrive?: CriticHarnessDrive | undefined;
  /** Test-only Scheduled Job registrations. */
  scheduledJobRegistrations?: ScheduledJobRegistration[] | undefined;
  /** Registers telemetry's metrics-summary flush as a Scheduler Job; undefined when telemetry owns its own timer. */
  metricsSummary?: { intervalMs: number; flush: () => Promise<void> } | undefined;
  /** Test-only distribution mode override. */
  distributionMode?: DistributionMode | undefined;
  /** Test-only npm registry lookup override for the Update Check Job. */
  updateCheckLatest?: (() => Promise<string>) | undefined;
  /** Test-only running-version override, so Update Check tests don't track the release version. */
  version?: string | undefined;
  onUpgradeIdle?: ((version: string) => Promise<void> | void) | undefined;
  migrationRequired?: boolean | undefined;
  /** How this instance was installed; drives whether arming is allowed and what `GET /update` offers as the manual command. Defaults to `{ kind: 'systemd' }`. */
  installMode?: InstallMode | undefined;
  /** Reads `app/rollback.json` written by the boot guard, if the last boot rolled back. */
  readRollback?: (() => { reason: string } | undefined) | undefined;
  clearRollback?: (() => void) | undefined;
  /** True for a root system unit that predates the boot guard (ADR-0042): auto-upgrade still runs, but with no automatic rollback until `sudo harmonic install` reinstalls it. */
  guardMissing?: boolean | undefined;
}

export interface AppContext {
  distributionMode: DistributionMode;
  runningVersion: string;
  installMode: InstallMode;
  guardMissing: boolean;
  updateCheck: UpdateCheck;
  upgrade: UpgradeCoordinator;
  asyncDb: AsyncDbHandle;
  statsReader: StatsWorkerClient;
  settingsStore: SettingsStore;
  workspaces: WorkspaceService;
  tasks: TaskService;
  attempts: AttemptStore;
  taskEvents: TaskEventStore;
  sessions: SessionStore;
  runner: Runner;
  conversations: ConversationStore;
  conversationDriver: ConversationDriver;
  permissionRules: PermissionRuleStore;
  escalation: EscalationService;
  autoRunner: AutoRunner;
  globalPause: GlobalPause;
  guardrailEvents: GuardrailEventStore;
  verificationAttempts: VerificationAttemptStore;
  trackerManager: TrackerPollerManager;
  epicService: EpicService;
  scheduler: Scheduler;
  auth: AuthService;
  channels: ChannelService;
  notifier: Notifier;
  bus: EventBus;
  hostLoad: HostLoadSampler;
  workspaceWatcher: WorkspaceWatcher;
  worktreeInventory: WorktreeInventory;
  forceCleanupWorktree: (id: string, workspaceId?: number) => Promise<boolean | null>;
  dirtyWorktreeFiles: (id: string, workspaceId?: number) => Promise<string[] | null>;
  reconcileWorktrees: (workspaceId?: number) => ReturnType<WorktreeReconciler['reconcile']>;
  worktreesReconciledAt: () => number | null;
}

export type PersistenceContext = Pick<
  AppContext,
  | 'asyncDb'
  | 'statsReader'
  | 'settingsStore'
  | 'workspaces'
  | 'tasks'
  | 'attempts'
  | 'taskEvents'
  | 'sessions'
  | 'conversations'
  | 'permissionRules'
  | 'guardrailEvents'
  | 'verificationAttempts'
  | 'auth'
  | 'channels'
>;

export type ExecutionContext = Pick<
  AppContext,
  | 'tasks'
  | 'settingsStore'
  | 'workspaces'
  | 'attempts'
  | 'sessions'
  | 'runner'
  | 'conversations'
  | 'conversationDriver'
  | 'escalation'
  | 'autoRunner'
  | 'globalPause'
  | 'guardrailEvents'
  | 'verificationAttempts'
  | 'auth'
  | 'notifier'
  | 'bus'
  | 'worktreeInventory'
  | 'forceCleanupWorktree'
  | 'dirtyWorktreeFiles'
  | 'worktreesReconciledAt'
>;

export type TrackingContext = Pick<AppContext, 'tasks' | 'workspaces' | 'settingsStore' | 'trackerManager' | 'epicService' | 'scheduler' | 'channels' | 'notifier' | 'bus' | 'workspaceWatcher'>;

export interface AppContexts {
  persistence: PersistenceContext;
  execution: ExecutionContext;
  tracking: TrackingContext;
}

export function createPersistenceContext(ctx: AppContext): PersistenceContext {
  const { asyncDb, statsReader, settingsStore, workspaces, tasks, attempts, taskEvents, sessions, conversations, permissionRules, guardrailEvents, verificationAttempts, auth, channels } = ctx;
  return { asyncDb, statsReader, settingsStore, workspaces, tasks, attempts, taskEvents, sessions, conversations, permissionRules, guardrailEvents, verificationAttempts, auth, channels };
}

export function createExecutionContext(ctx: AppContext): ExecutionContext {
  const { tasks, settingsStore, workspaces, attempts, sessions, runner, conversations, conversationDriver, escalation, autoRunner, globalPause, guardrailEvents, verificationAttempts, auth, notifier, bus, worktreeInventory, forceCleanupWorktree, dirtyWorktreeFiles, worktreesReconciledAt } = ctx;
  return { tasks, settingsStore, workspaces, attempts, sessions, runner, conversations, conversationDriver, escalation, autoRunner, globalPause, guardrailEvents, verificationAttempts, auth, notifier, bus, worktreeInventory, forceCleanupWorktree, dirtyWorktreeFiles, worktreesReconciledAt };
}

export function createTrackingContext(ctx: AppContext): TrackingContext {
  const { tasks, workspaces, settingsStore, trackerManager, epicService, scheduler, channels, notifier, bus, workspaceWatcher } = ctx;
  return { tasks, workspaces, settingsStore, trackerManager, epicService, scheduler, channels, notifier, bus, workspaceWatcher };
}

export function createAppContexts(ctx: AppContext): AppContexts {
  return {
    persistence: createPersistenceContext(ctx),
    execution: createExecutionContext(ctx),
    tracking: createTrackingContext(ctx),
  };
}

/** One Fastify route registration, as captured by the `onRoute` hook below. */
export interface RegisteredRoute {
  method: string;
  url: string;
}

export type App = FastifyInstance & { ctx: AppContext; registeredRoutes: RegisteredRoute[] };
