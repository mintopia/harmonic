import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { VerificationCoordinator, type VerificationCoordinatorDeps } from '../../src/execution/verification-coordinator.js';
import { trackerRef } from '../../src/tracker/adapter.js';
import { convertEditedEpicFixPrompts, epicFixTexts } from '../../src/domain/epic-fix-prompt.js';
import { planEpicSettingsMigration } from '../../src/domain/epic-settings-workflow-migration.js';
import { NO_RETIRED } from '../../src/domain/retired-settings.js';
import { PromptLibrary } from '../../src/domain/prompt-library-store.js';
import { SettingsStore } from '../../src/server/settings-store.js';
import type { CriticDriveRequest, CriticHarnessDrive } from '../../src/verification/critic.js';
import { createEpicEngineHarness, git } from './epic-engine-harness.js';

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

export interface FixtureEpicRun {
  prompts: string[];
  outcomes: string[];
}

export async function runFixtureEpic(resolvePrompt?: string): Promise<FixtureEpicRun> {
  const settingsDir = mkdtempSync(join(tmpdir(), 'harmonic-epic-golden-'));
  try {
    const base = (await SettingsStore.create(settingsDir)).getGlobal();
    const promptLibrary = new PromptLibrary(settingsDir);
    await promptLibrary.load();
    if (resolvePrompt) {
      await convertEditedEpicFixPrompts(promptLibrary, { ...base, verify: { ...base.verify, epic: { ...base.verify.epic, resolvePrompt } } }, NO_RETIRED);
    }
    const verify = { id: 'export-wired', command: 'sh', args: ['-c', 'test -f wired.ts || { printf %s "$1"; exit 1; }', 'sh', FIXTURE_FAILING_VERIFIER_REASON], env: {}, timeoutSeconds: 600 };
    const config: AppConfig = { ...base, verify: { ...base.verify, epic: { ...base.verify.epic, preMerge: { commands: [verify], critics: [] } } } };
    const plan = await planEpicSettingsMigration({ config, workspaces: [], library: await epicFixTexts(promptLibrary) });
    for (const prompt of plan.prompts) await promptLibrary.create(prompt.code, prompt.description, prompt.text);

    const prompts: string[] = [];
    const drive: CriticHarnessDrive = {
      run: async (request: CriticDriveRequest) => {
        prompts.push(request.prompt);
        writeFileSync(join(request.cwd, 'wired.ts'), 'export const wired = true;\n');
        git(request.cwd, 'add', '.');
        git(request.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'wire exporter to --export');
        return { output: '', permissionRequests: [] };
      },
    };
    let resolver: VerificationCoordinator | undefined;
    const harness = await createEpicEngineHarness({
      workflow: plan.workflows[0]!.text,
      epic: { title: FIXTURE_EPIC.title, body: FIXTURE_EPIC.body, url: FIXTURE_EPIC.url },
      config: (current) => ({ ...current, verify: config.verify }),
      prompts: { resolve: (text) => promptLibrary.resolve(text), engine: () => promptLibrary.enginePrompts() },
      drive: (request) => resolver!.runEpicAgentTurn(request),
    });
    try {
      resolver = new VerificationCoordinator({
        routing: { epicRoute: async () => { throw new Error('the engine routes the Epic agent step'); } },
        attempts: harness.attempts,
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
        promptLibrary,
      } as unknown as VerificationCoordinatorDeps);
      const outcomes = [(await harness.submit()).status, ...harness.escalations.map((reason) => `escalated: ${reason}`)];
      return { prompts, outcomes };
    } finally {
      await harness.dispose();
    }
  } finally {
    rmSync(settingsDir, { recursive: true, force: true });
  }
}
