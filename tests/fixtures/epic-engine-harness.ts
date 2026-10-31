import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig, type AppConfig } from '../../src/config.js';
import { openAsyncDb, type AsyncDbHandle } from '../../src/db/async.js';
import { epics, workspaces, type WorkspaceRow } from '../../src/db/schema.js';
import { AttemptStore } from '../../src/domain/attempts.js';
import { bundledEnginePrompts } from '../../src/domain/bundled-prompts.js';
import { WorkflowStepRunStore } from '../../src/domain/workflow-step-runs.js';
import { EpicCoordinator, integrationBranchName, type EpicIntegrateOutcome } from '../../src/execution/epic-coordinator.js';
import { EpicWorktreePool } from '../../src/execution/epic-worktree-pool.js';
import { runMergePolicy } from '../../src/execution/merge-policy.js';
import type { AgentDrive, EpicSubject } from '../../src/execution/workflow-engine.js';
import { trackerRef } from '../../src/tracker/adapter.js';
import { EpicWorkflowRunner, type EpicWorkflowRunnerDeps } from '../../src/tracker/epic-workflow-runner.js';
import type { MergeEpicIntegration } from '../../src/tracker/epic-service.js';
import { createChildProcessSpawn } from '../../src/verification/command-verifier.js';
import { seedWorkspace, testSpawnProcessGroup } from '../helpers.js';

export const EPIC_REF = trackerRef(42);
export const WORKFLOW_NAME = 'epic-test';

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitIdentity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com'];

export function epicWorkflow(verify: string, max = 2, withClose = true): string {
  return `name: ${WORKFLOW_NAME}
description: test
subject: epic
steps:
  - attempts:
      max: ${max}
      steps:
        - id: resolve
          if: \${{ attempt.number > 1 }}
          uses: agent
          with:
            prompt: 'resolve the Epic: {reason}'
        - id: verify
          run: ${JSON.stringify(verify)}
  - id: merge
    uses: merge
${withClose ? '  - id: close-ticket\n    uses: close-ticket\n' : ''}cleanup:
  - id: cleanup
    uses: cleanup
`;
}

export interface EpicEngineHarnessOptions {
  workflow: string;
  drive?: AgentDrive<EpicSubject>['run'];
  merge?: MergeEpicIntegration;
  config?: (config: AppConfig) => AppConfig;
  prompts?: { resolve: (text: string) => Promise<string>; engine: () => ReturnType<typeof bundledEnginePrompts> };
  members?: number;
  epic?: { title: string; body: string; url: string };
}

export interface EpicEngineHarness {
  root: string;
  repoDir: string;
  db: AsyncDbHandle;
  attempts: AttemptStore;
  stepRuns: WorkflowStepRunStore;
  workspaceId: number;
  escalations: string[];
  recorded: Array<{ mergeCommit: string | null; memberRefs: string[] }>;
  closed: string[];
  driveCalls: number;
  pinned: Map<string, string>;
  submit(): Promise<EpicIntegrateOutcome>;
  resume(guidance: string): void;
  dispose(): Promise<void>;
}

export async function createEpicEngineHarness(options: EpicEngineHarnessOptions): Promise<EpicEngineHarness> {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-engine-'));
  const repoDir = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
  writeFileSync(join(repoDir, 'README.md'), 'base\n');
  git(repoDir, 'add', '.');
  git(repoDir, ...gitIdentity, 'commit', '-qm', 'base');
  const branch = integrationBranchName(EPIC_REF);
  git(repoDir, 'branch', branch);
  git(repoDir, 'checkout', '-q', branch);
  for (let member = 1; member <= (options.members ?? 2); member++) {
    git(repoDir, 'checkout', '-q', '-b', `member-${member}`, 'main');
    writeFileSync(join(repoDir, `member-${member}.txt`), `member ${member}\n`);
    git(repoDir, 'add', '.');
    git(repoDir, ...gitIdentity, 'commit', '-qm', `member ${member}`);
    git(repoDir, 'checkout', '-q', branch);
    git(repoDir, ...gitIdentity, 'merge', '--no-ff', '-qm', `merge member ${member}`, `member-${member}`);
  }
  git(repoDir, 'checkout', '-q', 'main');

  const db = await openAsyncDb(root);
  const workspaceId = await seedWorkspace(db, repoDir);
  await db.write((d) => d.insert(epics).values({ workspaceId, trackerRef: EPIC_REF, kind: 'epic', state: 'open' } as typeof epics.$inferInsert).run());
  const workspace = (await db.read((d) => d.select().from(workspaces).get())) as unknown as WorkspaceRow;
  const config = (options.config ?? ((c) => c))({ ...baselineConfig(), defaults: { ...baselineConfig().defaults, epicWorkflow: WORKFLOW_NAME } });
  const entry = { name: WORKFLOW_NAME, description: '', subject: 'epic' as const, text: options.workflow, bundled: false, version: 1 };
  const attempts = new AttemptStore(db);
  const stepRuns = new WorkflowStepRunStore(db);
  const harnessConfig = Object.values(config.harnesses)[0] as AppConfig['harnesses'][keyof AppConfig['harnesses']];
  const state: EpicEngineHarness = { root, repoDir, db, attempts, stepRuns, workspaceId, escalations: [], recorded: [], closed: [], driveCalls: 0, pinned: new Map(), submit: async () => ({ status: 'noop', reason: '' }), resume: () => undefined, dispose: async () => undefined };

  const merge: MergeEpicIntegration = options.merge ?? ((input) => runMergePolicy(
    { baseDir: input.repoDir, baseBranch: input.defaultBranch, taskBranch: input.integrationBranch, conflictResolveTurns: 0, postMergeCheck: true },
    { resolveConflictTurn: async () => undefined, runPostMergeCheck: input.runPostMergeCheck, escalate: async () => undefined },
  ));
  const worktreesDir = join(root, 'worktrees');
  mkdirSync(worktreesDir);
  const worktrees = new EpicWorktreePool({ workspaceId, worktreesDir });
  const runner = new EpicWorkflowRunner({
    workspace,
    getWorkspaces: async () => [workspace],
    getConfig: () => config,
    library: { list: () => [entry], get: () => entry, getVersion: async () => entry },
    stepRuns,
    epicAttempts: attempts,
    worktrees,
    mergeEpicIntegration: merge,
    commandSpawn: createChildProcessSpawn(testSpawnProcessGroup),
    workflowRefs: {
      get: async (_workspaceId, ref) => state.pinned.get(ref) ?? null,
      set: async (_workspaceId, ref, value) => { state.pinned.set(ref, value); },
    },
    tracker: { close: async (ref) => { state.closed.push(String(ref)); return true; }, comment: async () => true },
    agent: {
      drive: {
        run: async (req) => {
          if (req.task) state.driveCalls += 1;
          return (options.drive ?? (async () => ({ output: '', permissionRequests: [] })))(req);
        },
      },
      prompts: options.prompts?.engine ?? bundledEnginePrompts,
      route: async () => ({ ok: true, harness: 'claude', model: 'fixture-model', label: null, config: harnessConfig }),
      resolvePrompt: options.prompts?.resolve ?? (async (text) => text),
    },
  });
  const coordinator = new EpicCoordinator({
    repoDir,
    runWorkflow: (input) => runner.run(input),
    retire: async () => undefined,
    escalate: (_ref, reason) => state.escalations.push(reason),
    now: () => 0,
    verifyBackoffMs: 0,
    markIntegrating: async () => undefined,
    recordIntegration: async ({ mergeCommit, memberRefs }) => { state.recorded.push({ mergeCommit, memberRefs }); },
    onError: () => undefined,
  });
  const members = Array.from({ length: options.members ?? 2 }, () => 'completed' as const);
  state.submit = () => coordinator.submit({ ref: EPIC_REF, ...(options.epic ?? { title: 'Add export pipeline', body: 'Members must work together.', url: 'https://example.test/42' }), members, memberRefs: members.map((_, i) => trackerRef(43 + i)) });
  state.resume = (guidance) => coordinator.resume(EPIC_REF, guidance, 'fresh');
  state.dispose = async () => {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return state;
}

export function engineWiring(db: AsyncDbHandle, workflow: string, drive: AgentDrive<EpicSubject>['run']): { library: EpicWorkflowRunnerDeps['library']; stepRuns: WorkflowStepRunStore; resolvePrompt: (text: string) => Promise<string>; drive: AgentDrive<EpicSubject> } {
  const entry = { name: WORKFLOW_NAME, description: '', subject: 'epic' as const, text: workflow, bundled: false, version: 1 };
  return { library: { list: () => [entry], get: () => entry, getVersion: async () => entry }, stepRuns: new WorkflowStepRunStore(db), resolvePrompt: async (text) => text, drive: { run: drive } };
}
