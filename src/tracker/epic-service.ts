import type { AppConfig } from '../config.js';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEpicAttempt, type AttemptRow, type EpicAttemptRow, type EpicRow, type TaskRow, type WorkspaceRow } from '../db/schema.js';
import { AttemptStore } from '../domain/attempts.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { pricesForHarness, withCriticContribution } from '../domain/pricing.js';
import type { TaskService, TaskWithDeps } from '../domain/tasks.js';
import { deriveLeafEpics, type DerivedEpic } from '../domain/epic-derivation.js';
import { composeEpicView, type Epic, type EpicFacts, type EpicMeta } from '../domain/epic-view.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
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
import { collectUsage } from '../execution/usage.js';
import { criticAttemptToInput, runCritic, type CriticHarnessDrive } from '../verification/critic.js';
import type { MergePolicyOutcome, PostMergeCheckResult } from '../execution/merge-policy.js';
import { logger } from '../logger.js';
import type { EpicIntegrationSync } from './poller.js';
import { recordAndCloseIntegratedEpic } from './epic-close.js';
import type { Ticket, TrackerAdapter } from './adapter.js';
import { resolveTrackerAdapter } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { persistedTickets } from './persisted.js';

export type EpicResolutionDispatch = (input: {
  workspaceId: number;
  epicRef: number;
  title?: string;
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
    private readonly getConfig?: () => Pick<AppConfig, 'verify' | 'maxAttempts' | 'defaults' | 'harnesses'>,
    private readonly operations: EpicOperations = new EpicOperations(),
    private readonly mergeEpicIntegration?: MergeEpicIntegration,
    private readonly dispatchRefreshResolution: (
      target: EpicRefreshTarget,
      detail: string,
      escalate: (epicRef: number, reason: string) => void,
      retry: () => Promise<unknown>,
    ) => Promise<EpicRefreshResolveDispatchOutcome> = async () => ({ status: 'dispatched' }),
    private readonly epicMergeEvents?: EpicMergeEventStore,
    private readonly epicAttempts?: AttemptStore,
    private readonly dispatchEpicResolution?: EpicResolutionDispatch,
    private readonly worktreesDir?: string,
    private readonly onEpicAttemptChanged?: (attempt: EpicAttemptRow) => void,
    private readonly verificationAttemptStore?: VerificationAttemptStore,
    private readonly criticDrive?: CriticHarnessDrive,
  ) {}

  startWorkspace(workspace: WorkspaceRow): EpicIntegrationSync {
    const epics = new EpicLifecycle(this.tasks, workspace.workingDir);
    epics.attachOperations(this.operations);
    const entry: WorkspaceEpicEntry = { epics };
    const getConfig = this.getConfig;
    const mergeEpicIntegration = this.mergeEpicIntegration;
    const epicAttempts = this.epicAttempts;
    const dispatchEpicResolution = this.dispatchEpicResolution;
    const verificationAttemptStore = this.verificationAttemptStore;
    const criticDrive = this.criticDrive;
    if (getConfig && mergeEpicIntegration) {
      const resolveWorkspaceVerifiers = async () => {
        const live = (await this.getWorkspaces()).find((candidate) => candidate.id === workspace.id) ?? workspace;
        return resolveVerifiers(live, getConfig());
      };
      const verificationAttempts = new Map<number, EpicAttemptRow>();
      const publishEpicAttempt = (attempt: AttemptRow): void => {
        if (isEpicAttempt(attempt)) this.onEpicAttemptChanged?.(attempt);
      };
      const attemptWorktrees = new Map<number, string>();
      const releaseAttemptWorktree = async (epicRef: number): Promise<void> => {
        const worktreePath = attemptWorktrees.get(epicRef);
        if (!worktreePath) return;
        attemptWorktrees.delete(epicRef);
        await Git.removeWorktree(workspace.workingDir, worktreePath).catch(() => {});
      };
      const attemptWorktree = async (repoDir: string, epicRef: number): Promise<string> => {
        const existing = attemptWorktrees.get(epicRef);
        if (existing) return existing;
        const parent = this.worktreesDir ?? tmpdir();
        mkdirSync(parent, { recursive: true });
        const path = join(parent, `epic-attempt-${workspace.id}-${epicRef}`);
        try {
          await Git.addWorktreeCheckout(repoDir, path, integrationBranchName(epicRef));
        } catch {
          // This path is deterministic and solely owned by the Epic Attempt.
          // A crash can leave either Git's worktree registration or its directory.
          await Git.removeWorktree(repoDir, path).catch(() => rmSync(path, { recursive: true, force: true }));
          await Git.addWorktreeCheckout(repoDir, path, integrationBranchName(epicRef));
        }
        attemptWorktrees.set(epicRef, path);
        return path;
      };
      const verify = async ({ repoDir, epicRef, verifiedHeadOid }: { repoDir: string; epicRef: number; verifiedHeadOid: string }) => {
        const attempt = epicAttempts ? await epicAttempts.createForEpic({ workspaceId: workspace.id, epicRef }) : undefined;
        const criticUsages: Parameters<typeof withCriticContribution>[2] = [];
        if (attempt) {
          verificationAttempts.set(epicRef, attempt);
          publishEpicAttempt(attempt);
        }
        try {
          const worktreePath = await attemptWorktree(repoDir, epicRef);
          const decision = await verifyEpicIntegration({
            worktreePath,
            verifiedHeadOid,
            verifiers: (await resolveWorkspaceVerifiers()).epic.preMerge,
            runCritic: async ({ cwd, verifiedHeadOid: criticHeadOid, critic }) => {
              const config = getConfig();
              const harnessId = critic.harness ?? config.defaults.harness;
              const harness = config.harnesses[harnessId];
              if (!harness) {
                return {
                  verifier: 'critic',
                  verdict: 'inconclusive',
                  summary: `critic harness '${harnessId}' is not configured`,
                  output: '',
                };
              }
              const defaultBranch = await resolveRepositoryDefaultBranch(repoDir);
              const baseOid = defaultBranch === null
                ? null
                : await Git.mergeBase(repoDir, defaultBranch, integrationBranchName(epicRef)).catch(() => null);
              const criticAttempt = await runCritic({
                cwd,
                verifiedHeadOid: criticHeadOid,
                ...(baseOid ? { baseOid } : {}),
                critic: { prompt: critic.prompt, model: critic.model, ...(critic.harness ? { harness: critic.harness } : {}) },
                fields: { skill: '/implement', ref: String(epicRef), url: '', title: `Epic #${epicRef}`, body: '' },
                harness,
                harnessId,
                ...(criticDrive ? { drive: criticDrive } : {}),
              });
              const usage = collectUsage({
                harnessId,
                harness,
                cwd,
                sessionId: criticAttempt.sessionId,
                ...(criticAttempt.usage ? { promptResult: { usage: criticAttempt.usage } } : {}),
                prices: pricesForHarness(harness),
              });
              if (usage) criticUsages.push({ usage, prices: pricesForHarness(harness) });
              if (attempt && verificationAttemptStore) {
                const persisted = await verificationAttemptStore.append(attempt.id, {
                  ...criticAttemptToInput(criticAttempt),
                  ...(usage ? { usage: JSON.stringify(usage) } : {}),
                });
                const step = await epicAttempts!.createStep(attempt.id, {
                  type: 'review',
                  logLocator: `verification_attempt:${persisted.id}`,
                });
                await epicAttempts!.updateStep(step.id, {
                  state: criticAttempt.verdict === 'pass' ? 'passed' : 'failed',
                  verdict: criticAttempt.verdict,
                  startedAt: persisted.ts,
                  endedAt: Date.now(),
                });
              }
              return {
                verifier: criticAttempt.verifier,
                verdict: criticAttempt.verdict,
                summary: criticAttempt.summary,
                output: criticAttempt.output,
              };
            },
          });
          if (attempt && criticUsages.length > 0) {
            const contribution = withCriticContribution(null, null, criticUsages);
            publishEpicAttempt(await epicAttempts!.updateWithFrozenCost(attempt.id, {
              usage: contribution.usage ? JSON.stringify(contribution.usage) : null,
              cost: contribution.cost ? JSON.stringify(contribution.cost) : null,
            }));
          }
          if (attempt && decision.outcome === 'proceed') {
            publishEpicAttempt(await epicAttempts!.updateWithFrozenCost(attempt.id, { state: 'passed', reason: 'epic-verification', endedAt: Date.now(), verifiedHeadOid }));
            verificationAttempts.delete(epicRef);
          }
          return decision;
        } catch (error) {
          if (attempt) {
            publishEpicAttempt(await epicAttempts!.updateWithFrozenCost(attempt.id, {
              state: 'failed',
              reason: 'epic-verification',
              detail: error instanceof Error ? error.message : String(error),
              endedAt: Date.now(),
              verifiedHeadOid,
            }));
            verificationAttempts.delete(epicRef);
          }
          await releaseAttemptWorktree(epicRef);
          throw error;
        }
      };
      const epicIntegrate = new EpicCoordinator({
        repoDir: workspace.workingDir,
        verify,
        ...(epicAttempts && dispatchEpicResolution ? {
          resolve: async ({ repoDir, epicRef, title, verifiedHeadOid, verification }) => {
            const attempt = verificationAttempts.get(epicRef) ?? await epicAttempts.getRunningForEpic({ workspaceId: workspace.id, epicRef });
            if (!attempt) throw new Error(`Epic #${epicRef} has no running Attempt to resolve`);
            const maxAttempts = workspace.maxAttempts ?? getConfig().maxAttempts;
            if (attempt.number >= maxAttempts) {
              publishEpicAttempt(await epicAttempts.updateWithFrozenCost(attempt.id, {
                state: 'escalated',
                reason: 'epic-verification',
                detail: `Epic verification failed after ${maxAttempts} Attempt${maxAttempts === 1 ? '' : 's'}: ${verification.reason}`,
                endedAt: Date.now(),
                verifiedHeadOid,
              }));
              await releaseAttemptWorktree(epicRef);
              throw new Error(`Epic verification exhausted its ${maxAttempts}-Attempt limit: ${verification.reason}`);
            }
            try {
              const worktreePath = attemptWorktrees.get(epicRef);
              if (!worktreePath) throw new Error(`Epic #${epicRef} has no verification worktree to resolve`);
              await dispatchEpicResolution({
                workspaceId: workspace.id,
                epicRef,
                ...(title ? { title } : {}),
                repoDir,
                worktreePath,
                attempt,
                verifiedHeadOid,
                verificationReason: verification.reason,
                resolvePrompt: getConfig().verify.epic.resolvePrompt,
              });
              publishEpicAttempt(await epicAttempts.updateWithFrozenCost(attempt.id, {
                state: 'failed',
                reason: 'epic-verification',
                detail: verification.reason,
                endedAt: Date.now(),
                verifiedHeadOid,
              }));
            } catch (error) {
              publishEpicAttempt(await epicAttempts.updateWithFrozenCost(attempt.id, {
                state: 'escalated',
                reason: 'epic-resolution',
                detail: error instanceof Error ? error.message : String(error),
                endedAt: Date.now(),
                verifiedHeadOid,
              }));
              throw error;
            } finally {
              verificationAttempts.delete(epicRef);
              await releaseAttemptWorktree(epicRef);
            }
          },
        } : {}),
        integrate: async ({ repoDir, epicRef, defaultBranch, integrationBranch }) => {
          try {
            return await mergeEpicIntegration({
              workspaceId: workspace.id, repoDir, epicRef, defaultBranch, integrationBranch,
              runPostMergeCheck: async (mergeOid, baseDir) => {
                const stage = (await resolveWorkspaceVerifiers()).epic.preMerge;
                const decision = await verifyEpicIntegration({
                  worktreePath: baseDir,
                  verifiedHeadOid: mergeOid,
                  verifiers: { commands: stage.commands, critics: [] },
                  runCritic: async () => ({
                    verifier: 'critic',
                    verdict: 'inconclusive',
                    summary: 'critics do not run during the post-merge command check',
                    output: '',
                  }),
                });
                return { pass: decision.outcome === 'proceed', output: decision.outcome === 'proceed' ? '' : decision.reason };
              },
            });
          } finally {
            await releaseAttemptWorktree(epicRef);
          }
        },
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
    const mergeSteps = this.epicMergeEvents ? (await this.epicMergeEvents.list(workspaceId, epicRef)).map((event) => event.step) : [];
    return { integration: { branch, ...integration }, verification: { status: integrate?.verificationStatus(epicRef) ?? null, configured }, integrate: { inFlight: integrate?.isInFlight(epicRef) ?? false, held: integrate?.heldReason(epicRef) ?? null, phase: integrate?.activePhase(epicRef) ?? null }, mergeSteps };
  }
  private async epicBaseBranch(workspaceId: number): Promise<string | null> { const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); return workspace ? resolveRepositoryDefaultBranch(workspace.workingDir).catch(() => null) : null; }
  private async verificationConfigured(workspaceId: number): Promise<boolean> { const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); return !!workspace && !!this.getConfig && resolveVerifiers(workspace, this.getConfig()).epic.preMerge.commands.length > 0; }
}

function historicalEpicTicket(epic: DerivedEpic): Ticket {
  return { number: epic.ref, title: epic.title, state: 'closed', labels: [], parent: null, blockedBy: [], body: '', createdAt: '', closedAt: null, assignees: [], blocking: [], comments: [], isMap: false, url: '' };
}
