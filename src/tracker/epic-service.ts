import type { AppConfig } from '../config.js';
import type { EpicRow, TaskRow, WorkspaceRow } from '../db/schema.js';
import type { TaskService, TaskWithDeps } from '../domain/tasks.js';
import { deriveLeafEpics, type DerivedEpic } from '../domain/epic-derivation.js';
import { composeEpicView, type Epic, type EpicFacts, type EpicMeta } from '../domain/epic-view.js';
import { resolveVerifiers } from '../domain/setting-override.js';
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
} from '../execution/epic-coordinator.js';
import { verifyEpicIntegration } from '../execution/epic-verification.js';
import { Git } from '../execution/git.js';
import type { MergePolicyOutcome, PostMergeCheckResult } from '../execution/merge-policy.js';
import { logger } from '../logger.js';
import type { EpicIntegrationSync } from './poller.js';
import { recordAndCloseIntegratedEpic } from './epic-close.js';
import type { Ticket, TrackerAdapter } from './adapter.js';
import { resolveTrackerAdapter } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { persistedTickets } from './persisted.js';

export type MergeEpicIntegration = (input: {
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
  epicBaseNotReady(task: TaskRow): Promise<boolean>;
  refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void>;
  listEpics(workspaceId: number): Promise<Epic[]>;
  listEpicTickets(workspaceId: number): Promise<Ticket[]>;
  epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null>;
  epicDiff(workspaceId: number, epicRef: number): Promise<string>;
}

interface WorkspaceEpicEntry { epics: EpicLifecycle; epicIntegrate?: EpicCoordinator }

export class TrackerEpicService implements EpicService {
  private readonly entries = new Map<number, WorkspaceEpicEntry>();

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    private readonly resolveAdapter: (repoRoot: string, featureIndex?: FeatureIndex) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onError: (message: string) => void = logger.error,
    private readonly getConfig?: () => Pick<AppConfig, 'verify'>,
    private readonly operations: EpicOperations = new EpicOperations(),
    private readonly mergeEpicIntegration?: MergeEpicIntegration,
    private readonly dispatchRefreshResolution: (
      target: EpicRefreshTarget,
      detail: string,
      escalate: (epicRef: number, reason: string) => void,
      retry: () => Promise<unknown>,
    ) => Promise<EpicRefreshResolveDispatchOutcome> = async () => ({ status: 'dispatched' }),
  ) {}

  startWorkspace(workspace: WorkspaceRow): EpicIntegrationSync {
    const epics = new EpicLifecycle(this.tasks, workspace.workingDir);
    epics.attachOperations(this.operations);
    const entry: WorkspaceEpicEntry = { epics };
    const getConfig = this.getConfig;
    const mergeEpicIntegration = this.mergeEpicIntegration;
    if (getConfig && mergeEpicIntegration) {
      const resolveWorkspaceVerifiers = async () => {
        const live = (await this.getWorkspaces()).find((candidate) => candidate.id === workspace.id) ?? workspace;
        return resolveVerifiers(live, getConfig());
      };
      const epicIntegrate = new EpicCoordinator({
        repoDir: workspace.workingDir,
        verify: async ({ repoDir, verifiedHeadOid }) => verifyEpicIntegration({ repoDir, verifiedHeadOid, verifiers: await resolveWorkspaceVerifiers() }),
        integrate: ({ repoDir, epicRef, defaultBranch, integrationBranch }) => mergeEpicIntegration({
          repoDir, epicRef, defaultBranch, integrationBranch,
          runPostMergeCheck: async (mergeOid) => {
            const decision = await verifyEpicIntegration({ repoDir, verifiedHeadOid: mergeOid, verifiers: await resolveWorkspaceVerifiers() });
            return { pass: decision.outcome === 'proceed', output: decision.outcome === 'proceed' ? '' : decision.reason };
          },
        }),
        retire: (epicRef) => epics.retireIntegrationBranch(epicRef),
        escalate: (epicRef, reason) => this.onError(`epic ${epicRef} whole-Epic integrate escalated: ${reason}`),
        operations: this.operations,
        recordIntegration: ({ epicRef, mergeCommit, memberRefs }) => recordAndCloseIntegratedEpic({
          epicRef,
          settle: () => this.tasks.markEpicIntegrated(workspace.id, epicRef, { mergeCommit, memberRefs }),
          resolveAdapter: () => this.resolveAdapter(workspace.workingDir, (slug) => this.tasks.mdFeatureIndex(workspace.id, slug)),
          onError: this.onError,
        }),
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

  stopWorkspace(workspaceId: number): void { this.entries.delete(workspaceId); }

  async forceIntegrateEpic(workspaceId: number, epicRef: number): Promise<EpicIntegrateOutcome | null> {
    const entry = this.entries.get(workspaceId);
    return entry?.epicIntegrate?.submit({ ref: epicRef, members: [], memberRefs: entry.epics.membersOf(epicRef) }, { force: true }) ?? null;
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
    try {
      if (row?.state === 'integrated') return row.mergeCommit ? await Git.diffMergeCommit(workspace.workingDir, row.mergeCommit) : '';
      const base = await resolveRepositoryDefaultBranch(workspace.workingDir).catch(() => null);
      return base === null ? '' : await Git.diffUnified(workspace.workingDir, base, integrationBranchName(epicRef));
    } catch { return ''; }
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
      else if (ticketByRef.get(row.trackerRef)?.state === 'open') { const epic = live.get(row.trackerRef); if (epic) epics.push(epic); }
    }
    return epics.sort((a, b) => a.ref - b.ref);
  }
  private isHistorical(row: EpicRow): boolean { return row.state === 'integrated' && row.memberRefs !== null; }
  private storedToDerived(row: EpicRow, tickets: Ticket[], mirrored: TaskRow[]): DerivedEpic {
    return { ref: row.trackerRef, title: tickets.find((ticket) => ticket.number === row.trackerRef)?.title ?? mirrored.find((task) => task.trackerRef === row.trackerRef)?.trackerTitle ?? `Epic #${row.trackerRef}`, members: [...(row.memberRefs ?? [])].sort((a, b) => a - b), ready: [] };
  }
  private async composeOne(workspaceId: number, epic: DerivedEpic, tickets: Ticket[], mirrored: TaskRow[], baseBranch: string | null, rows: ReadonlyMap<number, EpicRow>, configured: boolean): Promise<Epic> {
    const titles = new Map(tickets.map((ticket) => [ticket.number, ticket.title])); const tasks = new Map<number, TaskRow>();
    for (const task of mirrored) if (task.trackerRef !== null) tasks.set(task.trackerRef, task);
    const ticket = tickets.find((candidate) => candidate.number === epic.ref); const row = rows.get(epic.ref);
    const meta: EpicMeta = { description: ticket?.body ?? '', createdAt: ticket ? Date.parse(ticket.createdAt) || 0 : 0, baseBranch, dependsOn: (ticket?.blockedBy ?? []).map((blocker) => blocker.number).sort((a, b) => a - b), kind: row?.kind === 'map' ? 'map' : 'spec', state: row?.state === 'integrated' ? 'integrated' : 'open' };
    return composeEpicView(epic, tasks, titles, await this.epicFacts(workspaceId, epic.ref, configured), meta);
  }
  private async epicFacts(workspaceId: number, epicRef: number, configured: boolean): Promise<EpicFacts> {
    const branch = integrationBranchName(epicRef); const integrate = this.entries.get(workspaceId)?.epicIntegrate;
    const integration = integrate ? await integrate.integrationFacts(epicRef) : { exists: false, tip: null };
    return { integration: { branch, ...integration }, verification: { status: integrate?.verificationStatus(epicRef) ?? null, configured }, integrate: { inFlight: integrate?.isInFlight(epicRef) ?? false, held: integrate?.heldReason(epicRef) ?? null } };
  }
  private async epicBaseBranch(workspaceId: number): Promise<string | null> { const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); return workspace ? resolveRepositoryDefaultBranch(workspace.workingDir).catch(() => null) : null; }
  private async verificationConfigured(workspaceId: number): Promise<boolean> { const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); return !!workspace && !!this.getConfig && resolveVerifiers(workspace, this.getConfig()).commands.length > 0; }
}

function historicalEpicTicket(epic: DerivedEpic): Ticket {
  return { number: epic.ref, title: epic.title, state: 'closed', labels: [], parent: null, blockedBy: [], body: '', createdAt: '', closedAt: null, assignees: [], blocking: [], comments: [], isMap: false, url: '' };
}
