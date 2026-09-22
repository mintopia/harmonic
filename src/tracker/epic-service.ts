import type { AppConfig } from '../config.js';
import { type AttemptRow, type EpicAttemptRow, type EpicRow, type TaskRow, type WorkspaceRow } from '../db/schema.js';
import { AttemptStore } from '../domain/attempts.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import type { TaskService, TaskWithDeps } from '../domain/tasks.js';
import { deriveLeafEpics, type DerivedEpic } from '../domain/epic-derivation.js';
import { composeEpicView, type Epic, type EpicFacts, type EpicMeta, type EpicTimelineEvent } from '../domain/epic-view.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { GitError } from '../domain/errors.js';
import { orFallback } from '../error-handling.js';
import { resolveRepositoryDefaultBranch } from '../execution/branch-merge.js';
import { EpicOperations } from '../execution/epic-operations.js';
import {
  EpicCoordinator,
  EpicLifecycle,
  EpicRefresh,
  integrationBranchName,
  type EpicIntegrateOutcome,
  type EpicRefreshResolveDispatchOutcome,
  type EpicRefreshTarget,
  type EpicResolve,
} from '../execution/epic-coordinator.js';
import { EpicWorktreePool } from '../execution/epic-worktree-pool.js';
import { Git } from '../execution/git.js';
import type { CriticHarnessDrive } from '../verification/critic.js';
import type { MergePolicyOutcome, PostMergeCheckResult } from '../execution/merge-policy.js';
import { logger } from '../logger.js';
import type { EpicIntegrationSync } from './poller.js';
import { recordAndCloseIntegratedEpic } from './epic-close.js';
import { EpicVerificationRunner } from './epic-verification-runner.js';
import { EpicResolutionRunner } from './epic-resolution-runner.js';
import { EpicIntegrationRunner } from './epic-integration-runner.js';
import type { Ticket, TrackerAdapter } from './adapter.js';
import { resolveTrackerAdapter } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { persistedTickets } from './persisted.js';

export type EpicResolutionDispatch = (input: {
  workspaceId: number;
  epicRef: number;
  title?: string;
  body?: string;
  url?: string;
  repoDir: string;
  worktreePath: string;
  attempt: AttemptRow;
  verifiedHeadOid: string;
  verificationReason: string;
  resolvePrompt: string;
}) => Promise<void>;

export type MergeEpicIntegration = (input: {
  workspaceId: number;
  repoDir: string;
  epicRef: number;
  defaultBranch: string;
  integrationBranch: string;
  runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
}) => Promise<MergePolicyOutcome>;
export type { EpicIntegrateOutcome };

export interface EpicService {
  startWorkspace(workspace: WorkspaceRow): EpicIntegrationSync;
  stopWorkspace(workspaceId: number): void;
  forceIntegrateEpic(workspaceId: number, epicRef: number): Promise<EpicIntegrateOutcome | null>;
  rejectEpic(workspaceId: number, epicRef: number, guidance: string, continuation: 'continue' | 'fresh'): Promise<EpicIntegrateOutcome | null>;
  epicBaseNotReady(task: TaskRow): Promise<boolean>;
  refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void>;
  listEpics(workspaceId: number): Promise<Epic[]>;
  listEpicTickets(workspaceId: number): Promise<Ticket[]>;
  epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null>;
  epicDiff(workspaceId: number, epicRef: number): Promise<string>;
}

interface WorkspaceEpicEntry { epics: EpicLifecycle; epicIntegrate?: EpicCoordinator }

/** Whole-Epic verification/integration/resolution stay dormant until both `getConfig` and `mergeEpicIntegration` are supplied. */
export interface TrackerEpicServiceOptions {
  resolveAdapter?: (repoRoot: string, featureIndex?: FeatureIndex) => Promise<TrackerAdapter>;
  onError?: (message: string) => void;
  getConfig?: (() => Pick<AppConfig, 'verify' | 'maxAttempts' | 'defaults' | 'harnesses'>) | undefined;
  operations?: EpicOperations;
  mergeEpicIntegration?: MergeEpicIntegration | undefined;
  dispatchRefreshResolution?: (
    target: EpicRefreshTarget,
    detail: string,
    escalate: (epicRef: number, reason: string) => void,
    retry: () => Promise<unknown>,
  ) => Promise<EpicRefreshResolveDispatchOutcome>;
  epicMergeEvents?: EpicMergeEventStore | undefined;
  epicAttempts?: AttemptStore | undefined;
  dispatchEpicResolution?: EpicResolutionDispatch | undefined;
  worktreesDir?: string | undefined;
  onEpicAttemptChanged?: ((attempt: EpicAttemptRow) => void) | undefined;
  onEpicMergeStep?: ((payload: { workspaceId: number; epicRef: number }) => void) | undefined;
  onEpicIntegrated?: ((payload: { workspaceId: number; epicRef: number }) => void) | undefined;
  verificationAttemptStore?: VerificationAttemptStore | undefined;
  criticDrive?: CriticHarnessDrive | undefined;
}

export class TrackerEpicService implements EpicService {
  private readonly entries = new Map<number, WorkspaceEpicEntry>();

  private readonly resolveAdapter: (repoRoot: string, featureIndex?: FeatureIndex) => Promise<TrackerAdapter>;
  private readonly onError: (message: string) => void;
  private readonly getConfig: TrackerEpicServiceOptions['getConfig'];
  private readonly operations: EpicOperations;
  private readonly mergeEpicIntegration: TrackerEpicServiceOptions['mergeEpicIntegration'];
  private readonly dispatchRefreshResolution: (
    target: EpicRefreshTarget,
    detail: string,
    escalate: (epicRef: number, reason: string) => void,
    retry: () => Promise<unknown>,
  ) => Promise<EpicRefreshResolveDispatchOutcome>;
  private readonly epicMergeEvents: TrackerEpicServiceOptions['epicMergeEvents'];
  private readonly epicAttempts: TrackerEpicServiceOptions['epicAttempts'];
  private readonly dispatchEpicResolution: TrackerEpicServiceOptions['dispatchEpicResolution'];
  private readonly worktreesDir: TrackerEpicServiceOptions['worktreesDir'];
  private readonly onEpicAttemptChanged: TrackerEpicServiceOptions['onEpicAttemptChanged'];
  private readonly onEpicMergeStep: TrackerEpicServiceOptions['onEpicMergeStep'];
  private readonly onEpicIntegrated: TrackerEpicServiceOptions['onEpicIntegrated'];
  private readonly verificationAttemptStore: TrackerEpicServiceOptions['verificationAttemptStore'];
  private readonly criticDrive: TrackerEpicServiceOptions['criticDrive'];

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    options: TrackerEpicServiceOptions = {},
  ) {
    this.resolveAdapter = options.resolveAdapter ?? resolveTrackerAdapter;
    this.onError = options.onError ?? logger.error;
    this.getConfig = options.getConfig;
    this.operations = options.operations ?? new EpicOperations();
    this.mergeEpicIntegration = options.mergeEpicIntegration;
    this.dispatchRefreshResolution = options.dispatchRefreshResolution ?? (async () => ({ status: 'dispatched' }));
    this.epicMergeEvents = options.epicMergeEvents;
    this.epicAttempts = options.epicAttempts;
    this.dispatchEpicResolution = options.dispatchEpicResolution;
    this.worktreesDir = options.worktreesDir;
    this.onEpicAttemptChanged = options.onEpicAttemptChanged;
    this.onEpicMergeStep = options.onEpicMergeStep;
    this.onEpicIntegrated = options.onEpicIntegrated;
    this.verificationAttemptStore = options.verificationAttemptStore;
    this.criticDrive = options.criticDrive;
  }

  startWorkspace(workspace: WorkspaceRow): EpicIntegrationSync {
    const epics = new EpicLifecycle(this.tasks, workspace.workingDir);
    epics.attachOperations(this.operations);
    epics.attachIntegrationBranchRetired(async ({ epicRef, branch, baseBranch }) => {
      if (!this.epicMergeEvents) return;
      await this.epicMergeEvents.append(workspace.id, epicRef, { step: 'retired', branch, baseBranch });
      this.onEpicMergeStep?.({ workspaceId: workspace.id, epicRef });
    });
    const entry: WorkspaceEpicEntry = { epics };
    const { getConfig, mergeEpicIntegration } = this;
    if (getConfig && mergeEpicIntegration) {
      const worktrees = new EpicWorktreePool({ workspaceId: workspace.id, worktreesDir: this.worktreesDir });
      const verification = new EpicVerificationRunner({
        workspace,
        getWorkspaces: this.getWorkspaces,
        getConfig,
        worktrees,
        epicAttempts: this.epicAttempts,
        verificationAttemptStore: this.verificationAttemptStore,
        onEpicAttemptChanged: this.onEpicAttemptChanged,
        criticDrive: this.criticDrive,
      });
      const integration = new EpicIntegrationRunner({
        workspace,
        worktreesDir: this.worktreesDir,
        worktrees,
        epics,
        mergeEpicIntegration,
        resolveWorkspaceVerifiers: () => verification.resolveWorkspaceVerifiers(),
      });
      const { epicAttempts, dispatchEpicResolution } = this;
      const resolution = epicAttempts && dispatchEpicResolution
        ? new EpicResolutionRunner({ workspace, getConfig, epicAttempts, dispatchEpicResolution, verification, onEpicAttemptChanged: this.onEpicAttemptChanged })
        : undefined;
      const epicIntegrate = new EpicCoordinator({
        repoDir: workspace.workingDir,
        verify: (input) => verification.verify(input),
        ...(resolution ? { resolve: (input: Parameters<EpicResolve>[0]) => resolution.resolve(input) } : {}),
        integrate: (input) => integration.integrate(input),
        retire: (epicRef) => integration.retire(epicRef),
        escalate: (epicRef, reason) => this.escalateEpicIntegration(epicRef, reason),
        operations: this.operations,
        markIntegrating: (epicRef) => this.tasks.markEpicIntegrating(workspace.id, epicRef),
        recordIntegration: (input) => this.recordEpicIntegration(workspace, input),
        onIntegrated: ({ epicRef }) => this.onEpicIntegrated?.({ workspaceId: workspace.id, epicRef }),
        epicState: (epicRef) => this.tasks.epicState(workspace.id, epicRef),
        onCompletedInPlace: ({ epicRef, baseBranch, leftBranch }) => {
          if (!this.epicMergeEvents) return;
          void this.epicMergeEvents
            .append(workspace.id, epicRef, { step: 'completed-in-place', baseBranch, ...(leftBranch !== undefined ? { leftBranch } : {}) })
            .then(() => {
              this.onEpicMergeStep?.({ workspaceId: workspace.id, epicRef });
            });
        },
      });
      entry.epicIntegrate = epicIntegrate;
      epics.attachIntegrateTrigger(epicIntegrate);
    }
    const noteRefreshBehind = (ref: number, reason: string): void => {
      if (entry.epicIntegrate) entry.epicIntegrate.recordRefreshBehind(ref, reason);
      else logger.debug(`epic ${ref} integration refresh behind develop (retrying): ${reason}`);
    };
    const refresh = new EpicRefresh({
      dispatchResolve: (target, detail) => this.dispatchRefreshResolution(target, detail, noteRefreshBehind, () => refresh.refresh(target)),
      escalate: noteRefreshBehind,
    });
    epics.attachRefreshTrigger(refresh);
    this.entries.set(workspace.id, entry);
    return epics;
  }

  private escalateEpicIntegration(epicRef: number, reason: string): void {
    this.onError(`epic ${epicRef} whole-Epic integrate escalated: ${reason}`);
  }

  private recordEpicIntegration(workspace: WorkspaceRow, { epicRef, mergeCommit, memberRefs }: { epicRef: number; mergeCommit: string | null; memberRefs: number[] }): Promise<void> {
    return recordAndCloseIntegratedEpic({
      epicRef,
      settle: () => this.tasks.markEpicIntegrated(workspace.id, epicRef, { mergeCommit, memberRefs }),
      resolveAdapter: () => this.resolveAdapter(workspace.workingDir, (slug) => this.tasks.mdFeatureIndex(workspace.id, slug)),
      onError: this.onError,
    });
  }

  stopWorkspace(workspaceId: number): void { this.entries.delete(workspaceId); }

  async forceIntegrateEpic(workspaceId: number, epicRef: number): Promise<EpicIntegrateOutcome | null> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return null;
    if (entry.epics.isInPlace(epicRef, await this.tasks.list({ workspaceId }))) {
      return { status: 'noop', reason: 'direct-mode epic completes in place; nothing to integrate' };
    }
    return entry.epicIntegrate?.submit({ ref: epicRef, members: [], memberRefs: entry.epics.membersOf(epicRef) }, { force: true }) ?? null;
  }

  async rejectEpic(workspaceId: number, epicRef: number, guidance: string, continuation: 'continue' | 'fresh'): Promise<EpicIntegrateOutcome | null> {
    const entry = this.entries.get(workspaceId);
    const coordinator = entry?.epicIntegrate;
    if (!entry || !coordinator || !this.epicAttempts) return null;
    if (entry.epics.isInPlace(epicRef, await this.tasks.list({ workspaceId }))) {
      return { status: 'noop', reason: 'direct-mode epic completes in place; nothing to integrate' };
    }
    if (coordinator.heldReason(epicRef) === null) return null;
    const attempt = await this.epicAttempts.currentForEpic({ workspaceId, epicRef });
    if (attempt.state !== 'escalated') return null;
    await this.epicAttempts.update(attempt.id, {
      state: 'running',
      endedAt: null,
      feedback: guidance,
      ...(continuation === 'fresh' ? { sessionId: null, sessionRowId: null } : {}),
    });
    coordinator.resume(
      epicRef,
      guidance,
      continuation,
      continuation === 'continue' && attempt.sessionId && attempt.sessionRowId !== null
        ? { id: attempt.sessionId, rowId: attempt.sessionRowId }
        : undefined,
    );
    return coordinator.submit({ ref: epicRef, members: [], memberRefs: entry.epics.membersOf(epicRef) }, { force: true });
  }

  async epicBaseNotReady(task: TaskRow): Promise<boolean> {
    return (await (task.workspaceId === null ? undefined : this.entries.get(task.workspaceId))?.epics.memberBaseNotReady(task)) ?? false;
  }

  async refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void> {
    const workspace = (await this.getWorkspaces()).find((candidate) => candidate.workingDir === workingDir);
    const entry = workspace && this.entries.get(workspace.id);
    if (entry) await entry.epics.refreshAfterDefaultBranchAdvance(defaultBranch);
  }

  async listEpics(workspaceId: number): Promise<Epic[]> {
    const { mirrored, tickets, rows } = await this.epicData(workspaceId);
    const rowByRef = new Map(rows.map((row) => [row.trackerRef, row] as const));
    const baseBranch = await this.epicBaseBranch(workspaceId);
    const configured = await this.verificationConfigured(workspaceId);
    return Promise.all(this.surfacedEpics(rows, tickets, mirrored, false).map((epic) => this.composeOne(workspaceId, epic, tickets, mirrored, baseBranch, rowByRef, configured)));
  }

  async listEpicTickets(workspaceId: number): Promise<Ticket[]> {
    const { mirrored, tickets, rows } = await this.epicData(workspaceId);
    const byRef = new Map(tickets.map((ticket) => [ticket.number, ticket]));
    return this.surfacedEpics(rows, tickets, mirrored, true).map((epic) => byRef.get(epic.ref) ?? historicalEpicTicket(epic));
  }

  async epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null> {
    const { mirrored, tickets, rows } = await this.epicData(workspaceId);
    const row = rows.find((candidate) => candidate.trackerRef === epicRef);
    if (!row) return null;
    const epic = this.isHistorical(row) ? this.storedToDerived(row, tickets, mirrored) : this.liveEpics(tickets, mirrored).get(epicRef);
    if (!epic) return null;
    return this.composeOne(workspaceId, epic, tickets, mirrored, await this.epicBaseBranch(workspaceId), new Map(rows.map((item) => [item.trackerRef, item] as const)), await this.verificationConfigured(workspaceId));
  }

  async epicDiff(workspaceId: number, epicRef: number): Promise<string> {
    const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId);
    if (!workspace) return '';
    const row = (await this.tasks.listStoredEpics(workspaceId)).find((candidate) => candidate.trackerRef === epicRef);
    return await orFallback(
      async () => {
        if (row?.state === 'integrated') return row.mergeCommit ? await Git.diffMergeCommit(workspace.workingDir, row.mergeCommit) : '';
        const base = await orFallback(
          () => resolveRepositoryDefaultBranch(workspace.workingDir),
          { op: 'epicService.epicDiff.defaultBranch', level: 'warn', context: { workspaceId, repoDir: workspace.workingDir } },
          null,
        );
        return base === null ? '' : await Git.diffUnified(workspace.workingDir, base, integrationBranchName(epicRef));
      },
      {
        op: 'epicService.epicDiff',
        level: 'warn',
        notFoundIf: (err) => err instanceof GitError && /unknown revision|bad revision|ambiguous argument/i.test(err.stderr),
        context: {
          workspaceId,
          epicRef,
          repoDir: workspace.workingDir,
          epicState: row?.state ?? undefined,
          integrationBranch: integrationBranchName(epicRef),
        },
      },
      '',
    );
  }

  private async epicData(workspaceId: number) {
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    return { mirrored, tickets: await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId)), rows: await this.tasks.listStoredEpics(workspaceId) };
  }
  private liveEpics(tickets: Ticket[], mirrored: TaskWithDeps[]): Map<number, DerivedEpic> {
    const readiness = new Map<number, { agentWorkable: boolean }>();
    for (const task of mirrored) if (task.trackerRef !== null) readiness.set(task.trackerRef, { agentWorkable: task.agentWorkable });
    return new Map(deriveLeafEpics(tickets, readiness, { includeClosed: true }).map((epic) => [epic.ref, epic] as const));
  }
  private surfacedEpics(rows: EpicRow[], tickets: Ticket[], mirrored: TaskWithDeps[], includeHistorical: boolean): DerivedEpic[] {
    const live = this.liveEpics(tickets, mirrored); const ticketByRef = new Map(tickets.map((ticket) => [ticket.number, ticket])); const epics: DerivedEpic[] = [];
    for (const row of rows) {
      if (this.isHistorical(row)) { if (includeHistorical) epics.push(this.storedToDerived(row, tickets, mirrored)); }
      else if (row.state !== 'integrated' && ticketByRef.get(row.trackerRef)?.state === 'open') {
        const epic = live.get(row.trackerRef); if (epic) epics.push(epic);
      } else if (row.state !== 'integrated' && ticketByRef.get(row.trackerRef)?.state === 'closed') {
        epics.push(this.storedToDerived(row, tickets, mirrored));
      }
    }
    return epics.sort((a, b) => a.ref - b.ref);
  }
  private isHistorical(row: EpicRow): boolean { return row.state === 'integrated' && row.memberRefs !== null; }
  private storedToDerived(row: EpicRow, tickets: Ticket[], mirrored: TaskRow[]): DerivedEpic {
    const ticket = tickets.find((candidate) => candidate.number === row.trackerRef);
    return { ref: row.trackerRef, title: ticket?.title ?? mirrored.find((task) => task.trackerRef === row.trackerRef)?.trackerTitle ?? `Epic #${row.trackerRef}`, body: ticket?.body ?? '', url: ticket?.url ?? '', members: [...(row.memberRefs ?? [])].sort((a, b) => a - b), ready: [] };
  }
  private async composeOne(workspaceId: number, epic: DerivedEpic, tickets: Ticket[], mirrored: TaskRow[], baseBranch: string | null, rows: ReadonlyMap<number, EpicRow>, configured: boolean): Promise<Epic> {
    const titles = new Map(tickets.map((ticket) => [ticket.number, ticket.title])); const tasks = new Map<number, TaskRow>();
    for (const task of mirrored) if (task.trackerRef !== null) tasks.set(task.trackerRef, task);
    const ticket = tickets.find((candidate) => candidate.number === epic.ref); const row = rows.get(epic.ref);
    const meta: EpicMeta = { description: ticket?.body ?? '', createdAt: ticket ? Date.parse(ticket.createdAt) || 0 : 0, baseBranch, dependsOn: (ticket?.blockedBy ?? []).map((blocker) => blocker.number).sort((a, b) => a - b), kind: row?.kind === 'map' ? 'map' : 'spec', state: row?.state ?? 'open' };
    return composeEpicView(epic, tasks, titles, await this.epicFacts(workspaceId, epic.ref, configured), meta);
  }
  private async epicFacts(workspaceId: number, epicRef: number, configured: boolean): Promise<EpicFacts> {
    const branch = integrationBranchName(epicRef); const integrate = this.entries.get(workspaceId)?.epicIntegrate;
    const integration = integrate ? await integrate.integrationFacts(epicRef) : { exists: false, tip: null };
    const timelineEvents: EpicTimelineEvent[] = this.epicMergeEvents
      ? (await this.epicMergeEvents.list(workspaceId, epicRef)).map(({ seq, ts, step }) => ({ seq, at: ts, step }))
      : [];
    const mergeSteps = timelineEvents.map((event) => event.step);
    const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId);
    const verifiers = workspace && this.getConfig ? resolveVerifiers(workspace, this.getConfig()).epic.preMerge : { commands: [], critics: [] };
    const status = integrate?.verificationStatus(epicRef) ?? null;
    const labels = [...verifiers.commands.map((command) => [command.command, ...command.args].join(' ')), ...verifiers.critics.map((_, index) => `Critic ${index + 1}`)];
    return { integration: { branch, ...integration }, verification: { status, configured, stages: [{ label: 'Epic pre-merge', status, verifiers: labels }] }, integrate: { inFlight: integrate?.isInFlight(epicRef) ?? false, held: integrate?.heldReason(epicRef) ?? null, phase: integrate?.activePhase(epicRef) ?? null }, mergeSteps, timelineEvents };
  }
  private async epicBaseBranch(workspaceId: number): Promise<string | null> { const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); return workspace ? resolveRepositoryDefaultBranch(workspace.workingDir).catch(() => null) : null; }
  private async verificationConfigured(workspaceId: number): Promise<boolean> { const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); return !!workspace && !!this.getConfig && resolveVerifiers(workspace, this.getConfig()).epic.preMerge.commands.length > 0; }
}

function historicalEpicTicket(epic: DerivedEpic): Ticket {
  return { number: epic.ref, title: epic.title, state: 'closed', labels: [], parent: null, blockedBy: [], body: '', createdAt: '', closedAt: null, assignees: [], blocking: [], comments: [], isMap: false, url: '' };
}
