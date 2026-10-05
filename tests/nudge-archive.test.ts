import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { AutoDrive } from '../src/execution/auto-drive.js';
import { TurnCompletion, type TurnCompletionDeps } from '../src/execution/turn-completion.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import type { ActiveRun } from '../src/execution/active-runs.js';
import type { AcpDriver } from '../src/acp/driver.js';
import type { GuardrailSupervisor } from '../src/execution/guardrail-supervisor.js';
import type { TurnListeners } from '../src/execution/turn-listeners.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

const task = { id: 7, archiveId: 'arch-1', workspaceId: null, trackerRef: null, createdAt: Date.now(), prompt: 't', origin: 'mirrored' } as unknown as TaskRow;

function setup(config = baselineConfig()) {
  const dataDir = tmp('harmonic-nudge-archive-');
  const archive = new TaskArchive({ dataDir, ensureArchiveId: async () => 'arch-1', workspaceName: async () => null });
  const completion = new TurnCompletion({
    attempts: { measureAgentTurn: async (_id: number, turn: () => Promise<unknown>) => turn(), update: async () => ({}) },
    autoDrive: new AutoDrive(() => config, () => null),
    getConfig: () => config,
    getWorkspace: undefined,
  } as unknown as TurnCompletionDeps);
  return { archive, completion };
}

const baseActive = (over: Partial<ActiveRun> = {}): ActiveRun =>
  ({ attemptId: 1, taskId: 7, pauseRequested: false, externallySettled: false, escalateReason: null, agentFinished: false, idle: false, steerable: false, steerQueue: [], ...over }) as unknown as ActiveRun;

describe('nudges are archived as Resolved Prompts (ADR-0047)', () => {
  it('archives the continue nudge from config and records its locator and index', async () => {
    const config = baselineConfig();
    config.drive.continuePrompt = 'CUSTOM continue for Task {taskId}.';
    config.drive.continueAttempts = 1;
    const { archive, completion } = setup(config);
    const writer = archive.implementationStep(task, 1);
    const sent: string[] = [];
    const driver = { prompt: vi.fn(async (blocks: { text: string }[]) => { sent.push(blocks[0]!.text); return { stopReason: 'end_turn' }; }) } as unknown as AcpDriver;
    const record = vi.fn();

    await completion.drivePromptCycle({
      task,
      driver,
      active: baseActive(),
      guardrails: { checkProgressAtBoundary: async () => false } as unknown as GuardrailSupervisor,
      listeners: { stoppedShort: null, archive: writer } as unknown as TurnListeners,
      autoDriven: true,
      promptText: 'first turn',
      record,
    });
    await writer.close();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('CUSTOM continue for Task 7.');
    expect(await archive.readResolvedPrompt(task, 1, 'implementation/prompt.md', 0)).toBe('first turn');
    expect(await archive.readResolvedPrompt(task, 1, 'implementation/prompt.md', 1)).toBe(sent[1]);
    expect(record).toHaveBeenCalledWith('lifecycle', { event: 'continue', attempt: 1, locator: 'implementation/prompt.md', promptIndex: 1 });
  });

  it('archives the commit nudge from config and records its locator and index', async () => {
    const config = baselineConfig();
    config.drive.commitNudge = 'CUSTOM commit nudge.';
    const { archive, completion } = setup(config);
    const repo = tmp('harmonic-nudge-repo-');
    execFileSync('git', ['init', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);
    writeFileSync(join(repo, 'a.txt'), 'dirty\n');

    const writer = archive.implementationStep(task, 1);
    writer.appendPrompt('the first turn prompt');
    const sent: string[] = [];
    const driver = { prompt: vi.fn(async (blocks: { text: string }[]) => { sent.push(blocks[0]!.text); return { stopReason: 'end_turn' }; }) } as unknown as AcpDriver;
    const record = vi.fn();

    await (completion as unknown as { resolveImplementationHead(input: unknown): Promise<unknown> }).resolveImplementationHead({
      task,
      run: { id: 1, verifiedHeadOid: null } as AttemptRow,
      workspace: { cwd: repo, startDirty: false, baseRev: null },
      active: baseActive({ driver } as Partial<ActiveRun>),
      attemptNumber: 1,
      escalating: null,
      stoppedShort: null,
      connectionGone: false,
      result: {},
      record,
      archive: writer,
    });
    await writer.close();

    expect(sent).toEqual(['CUSTOM commit nudge.']);
    expect(await archive.readResolvedPrompt(task, 1, 'implementation/prompt.md', 1)).toBe('CUSTOM commit nudge.');
    expect(record).toHaveBeenCalledWith('lifecycle', { event: 'commit-nudge', locator: 'implementation/prompt.md', promptIndex: 1 });
  });
});
