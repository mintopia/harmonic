import type { AppConfig } from '../config.js';
import { type AttemptRow, type EpicAttemptRow, type EpicRow, type TaskRow, type WorkspaceRow } from '../db/schema.js';
import { AttemptStore } from '../domain/attempts.js';
import type { TaskService, TaskWithDeps } from '../domain/tasks.js';
import { deriveLeafEpics, type DerivedEpic } from '../domain/epic-derivation.js';
import { composeEpicView, type Epic, type EpicFacts, type EpicMeta, type EpicTimelineEvent } from '../domain/epic-view.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { GitError } from '../domain/errors.js';
import { orFallback, type FireAndForget } from '../error-handling.js';
import { resolveRepositoryDefaultBranch } from '../execution/branch-merge.js';
import { EpicOperations } from '../execution/epic-operations.js';
import type { EnginePrompts } from '../domain/bundled-prompts.js';
import {
  EpicCoordinator,
  EpicLifecycle,
  EpicRefresh,
  integrationBranchName,
  parseIntegrationBranch,
  reduceMemberState,
  type EpicBaseGate,
  type EpicIntegrateOutcome,
  type EpicRefreshResolveDispatchOutcome,
  type EpicRefreshResolveTarget,
} from '../execution/epic-coordinator.js';
import type { MemberMergeState } from '../domain/epic-integrate-decision.js';
import { isMergeStep } from '../domain/epic-merge-events.js';
import { epicVerifyFacts, type EpicVerifyFacts } from '../domain/epic-verify-facts.js';
import { resolveEpicWorkflow } from '../domain/workflow-assignment.js';
import { EpicWorktreePool } from '../execution/epic-worktree-pool.js';
import { Git } from '../execution/git.js';
import type { CommandSpawn } from '../verification/command-verifier.js';
import type { MergePolicyOutcome, PostMergeCheckResult } from '../execution/merge-policy.js';
import { logger } from '../logger.js';
import type { EpicIntegrationSync } from './poller.js';
import { closeIntegratedEpic, recordAndCloseIntegratedEpic } from './epic-close.js';
import { EpicWorkflowRunner, type EpicWorkflowRunnerDeps } from './epic-workflow-runner.js';
import type { WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import type { AgentDrive, EpicSubject } from '../execution/workflow-engine.js';
import type { Ticket, TrackerAdapter, TrackerRef } from './adapter.js';
import { formatTrackerRef } from './kinds.js';
import { effectiveTrackerKind, resolveTrackerAdapter, workspaceTrackerSettings, type WorkspaceTrackerSettings } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { persistedTickets } from './persisted.js';

export type EpicResolutionDispatch = (input: {
  workspaceId: number;
  epicRef: TrackerRef;
  title?: string;
  body?: string;
  url?: string;
  repoDir: string;
  worktreePath: string;
  attempt: AttemptRow;
  verifiedHeadOid: string;
  verificationReason: string;
}) => Promise<void>;

export type MergeEpicIntegration = (input: {
  workspaceId: number;
  repoDir: string;
  epicRef: TrackerRef;
  defaultBranch: string;
  integrationBranch: string;
  runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
}) => Promise<MergePolicyOutcome>;
export type { EpicBaseGate, EpicIntegrateOutcome };

export interface EpicService {
  startWorkspace(workspace: WorkspaceRow): EpicIntegrationSync;
  stopWorkspace(workspaceId: number): void;
  retryEpic(workspaceId: number, epicRef: TrackerRef, guidance: string, continuation: 'continue' | 'fresh'): Promise<EpicIntegrateOutcome | null>;
  epicBaseNotReady(task: TaskRow): Promise<EpicBaseGate>;
  refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void>;
  listEpics(workspaceId: number): Promise<Epic[]>;
  listEpicTickets(workspaceId: number): Promise<Ticket[]>;
  epicDetail(workspaceId: number, epicRef: TrackerRef): Promise<Epic | null>;
  epicDiff(workspaceId: number, epicRef: TrackerRef): Promise<string>;
}

interface WorkspaceEpicEntry { epics: EpicLifecycle; epicIntegrate?: EpicCoordinator }

/** Everything whole-Epic verification, integration and resolution need; supplied together or not at all. */
export interface EpicIntegrationWiring {
  getConfig: () => Pick<AppConfig, 'verify' | 'maxAttempts' | 'defaults' | 'harnesses' | 'modelOptions'>;
  prompts: () => EnginePrompts;
  mergeEpicIntegration: MergeEpicIntegration;
  commandSpawn: CommandSpawn;
  workflows: {
    library: EpicWorkflowRunnerDeps['library'];
    stepRuns: WorkflowStepRunStore;
    secrets?: EpicWorkflowRunnerDeps['secrets'];
    resolvePrompt: (text: string) => Promise<string>;
    drive: AgentDrive<EpicSubject>;
  };
}

export interface TrackerEpicServiceOptions {
  /** `'lifecycle-only'` runs Epic branch lifecycle with no whole-Epic verification or integration. */
  integration: EpicIntegrationWiring | 'lifecycle-only';
  resolveAdapter?: (repoRoot: string, featureIndex?: FeatureIndex, workspace?: WorkspaceTrackerSettings) => Promise<TrackerAdapter>;
  onError?: (message: string) => void;
  operations?: EpicOperations;
  dispatchRefreshResolution?: (
    target: EpicRefreshResolveTarget,
    detail: string,
    escalate: (epicRef: TrackerRef, reason: string) => void,
    retry: () => Promise<unknown>,
  ) => Promise<EpicRefreshResolveDispatchOutcome>;
  epicMergeEvents?: EpicMergeEventStore | undefined;
  epicAttempts?: AttemptStore | undefined;
  worktreesDir?: string | undefined;
  onEpicAttemptChanged?: ((attempt: EpicAttemptRow) => void) | undefined;
  onEpicMergeStep?: ((payload: { workspaceId: number; epicRef: TrackerRef }) => void) | undefined;
  onEpicIntegrated?: ((payload: { workspaceId: number; epicRef: TrackerRef }) => void) | undefined;
  fireAndForget: FireAndForget;
}

export class TrackerEpicService implements EpicService {
  private readonly entries = new Map<number, WorkspaceEpicEntry>();

  private readonly resolveAdapter: (repoRoot: string, featureIndex?: FeatureIndex, workspace?: WorkspaceTrackerSettings) => Promise<TrackerAdapter>;
  private readonly onError: (message: string) => void;
  private readonly integration: TrackerEpicServiceOptions['integration'];
  private readonly operations: EpicOperations;
  private readonly dispatchRefreshResolution: (
    target: EpicRefreshResolveTarget,
    detail: string,
    escalate: (epicRef: TrackerRef, reason: string) => void,
    retry: () => Promise<unknown>,
  ) => Promise<EpicRefreshResolveDispatchOutcome>;
  private readonly epicMergeEvents: TrackerEpicServiceOptions['epicMergeEvents'];
  private readonly epicAttempts: TrackerEpicServiceOptions['epicAttempts'];
  private readonly worktreesDir: TrackerEpicServiceOptions['worktreesDir'];
  private readonly onEpicAttemptChanged: TrackerEpicServiceOptions['onEpicAttemptChanged'];
  private readonly onEpicMergeStep: TrackerEpicServiceOptions['onEpicMergeStep'];
  private readonly onEpicIntegrated: TrackerEpicServiceOptions['onEpicIntegrated'];
  private readonly fireAndForget: FireAndForget;

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    options: TrackerEpicServiceOptions,
  ) {
    this.resolveAdapter = options.resolveAdapter ?? resolveTrackerAdapter;
    this.onError = options.onError ?? logger.error;
    this.integration = options.integration;
    this.operations = options.operations ?? new EpicOperations();
    this.dispatchRefreshResolution = options.dispatchRefreshResolution ?? (async () => ({ status: 'dispatched' }));
    this.epicMergeEvents = options.epicMergeEvents;
    this.epicAttempts = options.epicAttempts;
    this.worktreesDir = options.worktreesDir;
    this.onEpicAttemptChanged = options.onEpicAttemptChanged;
    this.onEpicMergeStep = options.onEpicMergeStep;
    this.onEpicIntegrated = options.onEpicIntegrated;
    this.fireAndForget = options.fireAndForget;
  }

  startWorkspace(workspace: WorkspaceRow): EpicIntegrationSync {
    const epics = new EpicLifecycle(this.tasks, workspace.workingDir, this.fireAndForget, Git, this.onError);
    epics.attachWorkspace(workspace.id);
    epics.attachOperations(this.operations);
    epics.attachIntegrationBranchRetired(async ({ epicRef, branch, baseBranch }) => {
      if (!this.epicMergeEvents) return;
      await this.epicMergeEvents.append(workspace.id, epicRef, { step: 'retired', branch, baseBranch });
      this.onEpicMergeStep?.({ workspaceId: workspace.id, epicRef });
    });
    epics.attachIntegrationBranchEvent(async (step) => {
      if (!this.epicMergeEvents) return;
      const epicRef = parseIntegrationBranch(step.branch);
      if (epicRef === null) return;
      if (step.step === 'branch-create-failed') {
        const rows = await this.epicMergeEvents.list(workspace.id, epicRef);
        const last = rows.at(-1)?.step;
        if (last?.step === 'branch-create-failed' && last.branch === step.branch && last.error === step.error) return;
      }
      await this.epicMergeEvents.append(workspace.id, epicRef, step);
      this.onEpicMergeStep?.({ workspaceId: workspace.id, epicRef });
    });
    const entry: WorkspaceEpicEntry = { epics };
    if (this.integration !== 'lifecycle-only') {
      const { getConfig, prompts, mergeEpicIntegration, commandSpawn, workflows } = this.integration;
      const epicAttempts = this.epicAttempts;
      if (!epicAttempts) throw new Error('Epic integration needs an Attempt store');
      const worktrees = new EpicWorktreePool({ workspaceId: workspace.id, worktreesDir: this.worktreesDir });
      const adapter = (): Promise<TrackerAdapter> => this.resolveAdapter(workspace.workingDir, (slug) => this.tasks.mdFeatureIndex(workspace.id, slug), workspaceTrackerSettings(workspace));
      const workflowRunner = new EpicWorkflowRunner({
        workspace,
        getWorkspaces: this.getWorkspaces,
        getConfig,
        library: workflows.library,
        stepRuns: workflows.stepRuns,
        epicAttempts,
        worktrees,
        mergeEpicIntegration,
        commandSpawn,
        secrets: workflows.secrets,
        workflowRefs: { get: (workspaceId, epicRef) => this.tasks.epicWorkflowRef(workspaceId, epicRef), set: (workspaceId, epicRef, ref) => this.tasks.setEpicWorkflowRef(workspaceId, epicRef, ref) },
        tracker: {
          close: async (epicRef, comment) => closeIntegratedEpic(await adapter(), epicRef, comment),
          comment: async (epicRef, body) => {
            const tracker = await adapter();
            if (!tracker.comment) return false;
            await tracker.comment({ ref: epicRef, title: '', state: 'open' }, body);
            return true;
          },
        },
        agent: { drive: workflows.drive, prompts, route: (workspaceId, epicRef) => this.tasks.routing.epicRoute(workspaceId, epicRef), resolvePrompt: workflows.resolvePrompt },
        onStepChanged: (owner) => { if ('epicRef' in owner) this.onEpicMergeStep?.(owner); },
        onEpicAttemptChanged: this.onEpicAttemptChanged,
      });
      const epicIntegrate = new EpicCoordinator({
        repoDir: workspace.workingDir,
        runWorkflow: (input) => workflowRunner.run(input),
        retire: async (epicRef) => {
          await worktrees.release(workspace.workingDir, epicRef);
          await epics.retireIntegrationBranch(epicRef);
        },
        escalate: (epicRef, reason) => this.escalateEpicIntegration(epicRef, reason),
        operations: this.operations,
        markIntegrating: (epicRef) => this.tasks.markEpicIntegrating(workspace.id, epicRef),
        recordIntegration: (input) => this.recordEpicIntegration(workspace, input),
        onIntegrated: ({ epicRef }) => this.onEpicIntegrated?.({ workspaceId: workspace.id, epicRef }),
        epicState: (epicRef) => this.tasks.epicState(workspace.id, epicRef),
        onCompletedInPlace: ({ epicRef, baseBranch, leftBranch }) => {
          if (!this.epicMergeEvents) return;
          const events = this.epicMergeEvents;
          this.fireAndForget(async () => {
            await events.append(workspace.id, epicRef, { step: 'completed-in-place', baseBranch, ...(leftBranch !== undefined ? { leftBranch } : {}) });
            this.onEpicMergeStep?.({ workspaceId: workspace.id, epicRef });
          }, { op: 'epicService.recordCompletedInPlace', level: 'error', context: { workspaceId: workspace.id, epicRef } });
        },
      });
      entry.epicIntegrate = epicIntegrate;
      epics.attachIntegrateTrigger(epicIntegrate);
    }
    const noteRefreshBehind = (ref: TrackerRef, reason: string): void => {
      if (entry.epicIntegrate) entry.epicIntegrate.recordRefreshBehind(ref, reason);
      else logger.debug(`epic ${ref} integration refresh behind develop (retrying): ${reason}`);
    };
    const refresh = new EpicRefresh({
      dispatchResolve: (target, detail) => this.dispatchRefreshResolution({ ...target, workspaceId: workspace.id }, detail, (ref, reason) => refresh.escalateTurn(ref, reason), () => refresh.completeTurn(target)),
      escalate: noteRefreshBehind,
    });
    epics.attachRefreshTrigger(refresh);
    this.entries.set(workspace.id, entry);
    return epics;
  }

  private escalateEpicIntegration(epicRef: TrackerRef, reason: string): void {
    this.onError(`epic ${epicRef} whole-Epic integrate escalated: ${reason}`);
  }

  private recordEpicIntegration(workspace: WorkspaceRow, { epicRef, mergeCommit, memberRefs }: { epicRef: TrackerRef; mergeCommit: string | null; memberRefs: TrackerRef[] }): Promise<void> {
    return recordAndCloseIntegratedEpic({
      epicRef,
      settle: () => this.tasks.markEpicIntegrated(workspace.id, epicRef, { mergeCommit, memberRefs }),
      resolveAdapter: () => this.resolveAdapter(workspace.workingDir, (slug) => this.tasks.mdFeatureIndex(workspace.id, slug), workspaceTrackerSettings(workspace)),
      onError: this.onError,
    });
  }

  stopWorkspace(workspaceId: number): void { this.entries.delete(workspaceId); }

  private async currentMemberStates(workspaceId: number, memberRefs: readonly TrackerRef[]): Promise<MemberMergeState[]> {
    const byRef = new Map<TrackerRef, TaskRow>();
    for (const row of await this.tasks.list({ workspaceId })) if (row.trackerRef != null) byRef.set(row.trackerRef, row);
    return Promise.all(memberRefs.map(async (ref) => {
      const task = byRef.get(ref);
      return reduceMemberState(task ? await this.tasks.get(task.id) : undefined);
    }));
  }

  async retryEpic(workspaceId: number, epicRef: TrackerRef, guidance: string, continuation: 'continue' | 'fresh'): Promise<EpicIntegrateOutcome | null> {
    const entry = this.entries.get(workspaceId);
    const coordinator = entry?.epicIntegrate;
    if (!entry || !coordinator || !this.epicAttempts) return null;
    if (entry.epics.isInPlace(epicRef, await this.tasks.list({ workspaceId }))) {
      return null;
    }
    if ((await this.escalationHold(workspaceId, epicRef)) === null) return null;
    coordinator.resume(epicRef, guidance, continuation);
    const memberRefs = entry.epics.membersOf(epicRef);
    const members = await this.currentMemberStates(workspaceId, memberRefs);
    return coordinator.submit({ ref: epicRef, members, memberRefs });
  }

  /** Held only once the escalated Attempt row exists too; `integrate.held` and `retryEpic` both read this. */
  private async escalationHold(workspaceId: number, epicRef: TrackerRef): Promise<string | null> {
    const held = this.entries.get(workspaceId)?.epicIntegrate?.heldReason(epicRef) ?? null;
    if (held === null || !this.epicAttempts) return null;
    return (await this.epicAttempts.currentForEpic({ workspaceId, epicRef })).state === 'escalated' ? held : null;
  }

  async epicBaseNotReady(task: TaskRow): Promise<EpicBaseGate> {
    return (await (task.workspaceId === null ? undefined : this.entries.get(task.workspaceId))?.epics.memberBaseNotReady(task)) ?? 'ready';
  }

  async refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void> {
    const workspace = (await this.getWorkspaces()).find((candidate) => candidate.workingDir === workingDir);
    const entry = workspace && this.entries.get(workspace.id);
    if (entry) await entry.epics.refreshAfterDefaultBranchAdvance(defaultBranch);
  }

  async listEpics(workspaceId: number): Promise<Epic[]> {
    const { mirrored, tickets, rows, formatRef } = await this.epicData(workspaceId);
    const rowByRef = new Map(rows.map((row) => [row.trackerRef, row] as const));
    const baseBranch = await this.epicBaseBranch(workspaceId);
    return Promise.all(this.surfacedEpics(rows, tickets, mirrored, false, formatRef).map((epic) => this.composeOne(workspaceId, epic, tickets, mirrored, baseBranch, rowByRef)));
  }

  async listEpicTickets(workspaceId: number): Promise<Ticket[]> {
    const { mirrored, tickets, rows, formatRef } = await this.epicData(workspaceId);
    const byRef = new Map(tickets.map((ticket) => [ticket.ref, ticket]));
    return this.surfacedEpics(rows, tickets, mirrored, true, formatRef).map((epic) => byRef.get(epic.ref) ?? historicalEpicTicket(epic));
  }

  async epicDetail(workspaceId: number, epicRef: TrackerRef): Promise<Epic | null> {
    const { mirrored, tickets, rows, formatRef } = await this.epicData(workspaceId);
    const row = rows.find((candidate) => candidate.trackerRef === epicRef);
    if (!row) return null;
    const epic = this.isHistorical(row) ? this.storedToDerived(row, tickets, mirrored, formatRef) : this.liveEpics(tickets, mirrored).get(epicRef);
    if (!epic) return null;
    return this.composeOne(workspaceId, epic, tickets, mirrored, await this.epicBaseBranch(workspaceId), new Map(rows.map((item) => [item.trackerRef, item] as const)));
  }

  async epicDiff(workspaceId: number, epicRef: TrackerRef): Promise<string> {
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
    const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId);
    const kindId = workspace ? await effectiveTrackerKind(workspace.workingDir, workspaceTrackerSettings(workspace)) : null;
    return { mirrored, tickets: await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId)), rows: await this.tasks.listStoredEpics(workspaceId), formatRef: (ref: TrackerRef) => formatTrackerRef(kindId, ref) };
  }
  private liveEpics(tickets: Ticket[], mirrored: TaskWithDeps[]): Map<TrackerRef, DerivedEpic> {
    const readiness = new Map<TrackerRef, { agentWorkable: boolean }>();
    for (const task of mirrored) if (task.trackerRef !== null) readiness.set(task.trackerRef, { agentWorkable: task.agentWorkable });
    return new Map(deriveLeafEpics(tickets, readiness, { includeClosed: true }).map((epic) => [epic.ref, epic] as const));
  }
  private surfacedEpics(rows: EpicRow[], tickets: Ticket[], mirrored: TaskWithDeps[], includeHistorical: boolean, formatRef: (ref: TrackerRef) => string): DerivedEpic[] {
    const live = this.liveEpics(tickets, mirrored); const ticketByRef = new Map(tickets.map((ticket) => [ticket.ref, ticket])); const epics: DerivedEpic[] = [];
    for (const row of rows) {
      if (this.isHistorical(row)) { if (includeHistorical) epics.push(this.storedToDerived(row, tickets, mirrored, formatRef)); }
      else if (row.state !== 'integrated' && ticketByRef.get(row.trackerRef)?.state === 'open') {
        const epic = live.get(row.trackerRef); if (epic) epics.push(epic);
      } else if (row.state !== 'integrated' && ticketByRef.get(row.trackerRef)?.state === 'closed') {
        epics.push(this.storedToDerived(row, tickets, mirrored, formatRef));
      }
    }
    return epics;
  }
  private isHistorical(row: EpicRow): boolean { return row.state === 'integrated' && row.memberRefs !== null; }
  private storedToDerived(row: EpicRow, tickets: Ticket[], mirrored: TaskRow[], formatRef: (ref: TrackerRef) => string): DerivedEpic {
    const ticket = tickets.find((candidate) => candidate.ref === row.trackerRef);
    return { ref: row.trackerRef, title: ticket?.title ?? mirrored.find((task) => task.trackerRef === row.trackerRef)?.trackerTitle ?? `Epic ${formatRef(row.trackerRef)}`, body: ticket?.body ?? '', url: ticket?.url ?? '', members: [...(row.memberRefs ?? [])], ready: [] };
  }
  private async composeOne(workspaceId: number, epic: DerivedEpic, tickets: Ticket[], mirrored: TaskRow[], baseBranch: string | null, rows: ReadonlyMap<TrackerRef, EpicRow>): Promise<Epic> {
    const titles = new Map(tickets.map((ticket) => [ticket.ref, ticket.title])); const tasks = new Map<TrackerRef, TaskRow>();
    for (const task of mirrored) if (task.trackerRef !== null) tasks.set(task.trackerRef, task);
    const ticket = tickets.find((candidate) => candidate.ref === epic.ref); const row = rows.get(epic.ref);
    const meta: EpicMeta = { description: ticket?.body ?? '', createdAt: ticket ? Date.parse(ticket.createdAt) || 0 : 0, baseBranch, dependsOn: (ticket?.blockedBy ?? []).map((blocker) => blocker.ref), kind: row?.kind === 'map' ? 'map' : 'spec', state: row?.state ?? 'open' };
    return composeEpicView(epic, tasks, titles, await this.epicFacts(workspaceId, epic.ref), meta);
  }
  private async epicFacts(workspaceId: number, epicRef: TrackerRef): Promise<EpicFacts> {
    const branch = integrationBranchName(epicRef); const integrate = this.entries.get(workspaceId)?.epicIntegrate;
    const integration = integrate ? await integrate.integrationFacts(epicRef) : { exists: false, tip: null };
    const timelineEvents: EpicTimelineEvent[] = this.epicMergeEvents
      ? (await this.epicMergeEvents.list(workspaceId, epicRef)).map(({ seq, ts, step }) => ({ seq, at: ts, step }))
      : [];
    const lastStartedIndex = timelineEvents.map((event) => event.step.step).lastIndexOf('started');
    const currentIntegration = lastStartedIndex === -1 ? timelineEvents : timelineEvents.slice(lastStartedIndex);
    const mergeSteps = currentIntegration.map((event) => event.step).filter(isMergeStep);
    const { configured, status: ranStatus, labels } = await this.verifyFacts(workspaceId, epicRef);
    const inFlight = integrate?.isInFlight(epicRef) ?? false;
    const status = ranStatus ?? (inFlight ? 'pending' : null);
    return { integration: { branch, ...integration }, verification: { status, configured, stages: configured ? [{ label: 'Epic workflow', status, verifiers: labels }] : [] }, integrate: { inFlight, held: await this.escalationHold(workspaceId, epicRef), phase: integrate?.activePhase(epicRef) ?? null }, mergeSteps, timelineEvents };
  }
  private async epicBaseBranch(workspaceId: number): Promise<string | null> { const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); return workspace ? resolveRepositoryDefaultBranch(workspace.workingDir).catch(() => null) : null; }
  private async verifyFacts(workspaceId: number, epicRef: TrackerRef): Promise<EpicVerifyFacts> {
    const none: EpicVerifyFacts = { configured: false, status: null, labels: [] };
    if (this.integration === 'lifecycle-only') return none;
    const { library, stepRuns } = this.integration.workflows;
    const pinned = await this.tasks.epicWorkflowRef(workspaceId, epicRef);
    try {
      if (pinned !== null) {
        const [name = '', version = ''] = pinned.split('@');
        const entry = await library.getVersion(name, Number(version));
        return epicVerifyFacts(entry.text, await stepRuns.latestByStep({ workspaceId, epicRef }, pinned));
      }
      const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId);
      const usable = new Set(library.list().filter((entry) => entry.subject === 'epic').map((entry) => entry.name));
      return epicVerifyFacts(library.get(resolveEpicWorkflow(workspace ?? null, this.integration.getConfig(), (name) => usable.has(name)).name).text, new Map());
    } catch (error) {
      this.onError?.(`epic verification facts for ${workspaceId}/${epicRef}: ${error instanceof Error ? error.message : String(error)}`);
      return none;
    }
  }
}

function historicalEpicTicket(epic: DerivedEpic): Ticket {
  return { ref: epic.ref, title: epic.title, state: 'closed', labels: [], parent: null, blockedBy: [], body: '', createdAt: '', closedAt: null, assignees: [], blocking: [], isMap: false, url: '' };
}
