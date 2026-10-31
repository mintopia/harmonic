import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import type { AttemptRow } from '../../src/db/schema.js';
import { EpicCoordinator, integrationBranchName } from '../../src/execution/epic-coordinator.js';
import { VerificationCoordinator, type VerificationCoordinatorDeps } from '../../src/execution/verification-coordinator.js';
import { trackerRef } from '../../src/tracker/adapter.js';
import type { CriticDriveRequest, CriticHarnessDrive } from '../../src/verification/critic.js';
import { SettingsStore } from '../../src/server/settings-store.js';

export const FIXTURE_EPIC = {
  ref: trackerRef(42),
  title: 'Add export pipeline',
  body: 'Members #43 (exporter) and #44 (CLI flag) must work together end to end.',
  url: 'https://github.com/example/repo/issues/42',
  members: ['completed', 'completed'] as const,
};

export const FIXTURE_FAILING_VERIFIER_REASON = [
  'verification block: command "npm test" failed',
  'tests/export.test.ts: exporter output is not wired to the --export flag',
].join('\n');

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export interface FixtureEpicRun {
  /** Resolved Prompts the Epic resolve loop sent, one per resolve turn, in order. */
  prompts: string[];
  outcomes: string[];
}

/** Drives a two-member Epic through one failing then one passing whole-Epic verify on the current (ADR-0028) path, capturing every Resolved Prompt the resolve turn sends. */
export async function runFixtureEpic(resolvePrompt?: string): Promise<FixtureEpicRun> {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-golden-'));
  try {
    const repoDir = join(root, 'repo');
    const worktreePath = join(root, 'epic-worktree');
    const gitEnv = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com'];
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
    writeFileSync(join(repoDir, 'README.md'), 'base\n');
    git(repoDir, 'add', '.');
    git(repoDir, ...gitEnv, 'commit', '-qm', 'base');
    const branch = integrationBranchName(FIXTURE_EPIC.ref);
    git(repoDir, 'branch', branch);
    git(repoDir, 'worktree', 'add', '-q', worktreePath, branch);
    writeFileSync(join(worktreePath, 'exporter.ts'), 'export const exporter = true;\n');
    git(worktreePath, 'add', '.');
    git(worktreePath, ...gitEnv, 'commit', '-qm', 'merge members #43 and #44');

    const config = (await SettingsStore.create(root)).getGlobal();
    const prompts: string[] = [];
    const drive: CriticHarnessDrive = {
      run: async (request: CriticDriveRequest) => {
        prompts.push(request.prompt);
        writeFileSync(join(worktreePath, 'wired.ts'), 'export const wired = true;\n');
        git(worktreePath, 'add', '.');
        git(worktreePath, ...gitEnv, 'commit', '-qm', 'wire exporter to --export');
        return { output: '', permissionRequests: [] };
      },
    };
    const harnessConfig = Object.values(config.harnesses)[0] as AppConfig['harnesses'][keyof AppConfig['harnesses']];
    const attempt = { id: 1, number: 1 } as AttemptRow;
    const noop = vi.fn(async () => undefined);
    const resolver = new VerificationCoordinator({
      routing: { epicRoute: async () => ({ ok: true, harness: 'claude', model: 'fixture-model', config: harnessConfig }) },
      attempts: {
        createStep: async () => ({ id: 1 }),
        updateStep: noop,
        appendEvent: async () => ({}),
        listToolCalls: async () => new Map(),
        update: noop,
        replaceToolCalls: noop,
        addAgentDuration: noop,
        updateWithFrozenCost: noop,
      },
      sessionStore: { recordDispatch: async () => ({ id: 1 }) },
      activeRuns: {
        getToolCallTotals: () => new Map(),
        setToolCallTotals: vi.fn(),
        nextProgressSequence: () => 1,
        deleteToolCallTotals: vi.fn(),
      },
      events: {},
      getConfig: () => config,
      getWorkspace: undefined,
      criticDrive: drive,
    } as unknown as VerificationCoordinatorDeps);

    let clock = 0;
    let verifyCalls = 0;
    const outcomes: string[] = [];
    const coordinator = new EpicCoordinator({
      repoDir,
      now: () => clock,
      verify: async () => (++verifyCalls === 1
        ? { outcome: 'block', reason: FIXTURE_FAILING_VERIFIER_REASON }
        : { outcome: 'proceed', reason: 'ok' }),
      resolve: async ({ epicRef, title, body, url, verifiedHeadOid, verification }) => {
        await resolver.resolveEpicVerification({
          workspaceId: 1,
          epicRef,
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
          ...(url ? { url } : {}),
          repoDir,
          worktreePath,
          attempt,
          verifiedHeadOid,
          verificationReason: verification.reason,
          resolvePrompt: resolvePrompt ?? config.verify.epic.resolvePrompt,
        });
      },
      integrate: async () => ({ kind: 'merged', mergeOid: 'merged-oid' }),
      retire: async () => undefined,
      escalate: (_ref, reason) => outcomes.push(`escalated: ${reason}`),
    });

    const target = { ref: FIXTURE_EPIC.ref, title: FIXTURE_EPIC.title, body: FIXTURE_EPIC.body, url: FIXTURE_EPIC.url, members: [...FIXTURE_EPIC.members] };
    outcomes.push((await coordinator.submit(target)).status);
    clock += 120_000;
    outcomes.push((await coordinator.submit(target)).status);
    return { prompts, outcomes };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
