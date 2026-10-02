import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore } from '../src/domain/sessions.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { TranscriptCapture } from '../src/execution/transcript-capture.js';
import { baselineConfig } from '../src/config.js';
import { createPostMergeCheck } from '../src/verification/post-merge-check.js';
import { EpicIntegrationRunner } from '../src/tracker/epic-integration-runner.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('createPostMergeCheck archive output', () => {
  let dir: string;
  let db: AsyncDbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-pmc-'));
    db = await openAsyncDb(dir);
    await seedWorkspace(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the full command output to the Task Archive', async () => {
    const settings = await makeSettingsStore(dir, {
      verify: {
        task: {
          postMerge: {
            commands: [{ id: 'pm-echo', command: process.execPath, args: ['-e', "console.log('post-merge-out')"], env: {}, timeoutSeconds: 30 }],
          },
        },
      },
    });
    const tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settings));
    const task = await tasks.create({ prompt: 'p' });
    const attempts = new AttemptStore(db);
    const run = await attempts.create(task.id);
    const verificationAttempts = new VerificationAttemptStore(db);
    const archive = new TaskArchive({
      dataDir: dir,
      ensureArchiveId: (id) => tasks.ensureArchiveId(id),
      workspaceName: async () => null,
    });
    const check = createPostMergeCheck({
      getWorkspace: async () => undefined,
      getConfig: () => settings.getGlobal(),
      verificationAttempts,
      attempts,
      archive,
      transcripts: new TranscriptCapture(new SessionStore(db), verificationAttempts, () => settings.getGlobal()),
    });

    const detached = { ...task, workspaceId: null };
    const result = await check({ task: detached, run, mergeOid: 'a'.repeat(40), baseDir: dir });

    expect(result.pass).toBe(true);
    const root = await archive.ensure(detached);
    const log = readFileSync(join(root, 'attempts', String(run.number), 'verification', 'post-merge', 'pm-echo', 'output.log'), 'utf8');
    expect(log).toContain('post-merge-out');
  });

  it('keeps the server-local archive path out of the failing output that becomes the escalation text', async () => {
    const settings = await makeSettingsStore(dir, {
      verify: {
        task: {
          postMerge: {
            commands: [{ id: 'pm-big', command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(250000)); process.exitCode = 1"], env: {}, timeoutSeconds: 30 }],
          },
        },
      },
    });
    const tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settings));
    const task = await tasks.create({ prompt: 'p' });
    const attempts = new AttemptStore(db);
    const run = await attempts.create(task.id);
    const verificationAttempts = new VerificationAttemptStore(db);
    const archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => null });
    const check = createPostMergeCheck({
      getWorkspace: async () => undefined,
      getConfig: () => settings.getGlobal(),
      verificationAttempts,
      attempts,
      archive,
      transcripts: new TranscriptCapture(new SessionStore(db), verificationAttempts, () => settings.getGlobal()),
    });

    const result = await check({ task: { ...task, workspaceId: null }, run, mergeOid: 'a'.repeat(40), baseDir: dir });

    expect(result.pass).toBe(false);
    expect(result.output).toContain('truncated');
    expect(result.output).not.toContain('output.log');
    expect(result.output).not.toContain(dir);
  });

  it('archives full Epic post-merge command output and records a verification attempt on the Epic Attempt', async () => {
    const settings = await makeSettingsStore(dir);
    const tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settings));
    const task = await tasks.create({ prompt: 'p' });
    const attempts = new AttemptStore(db);
    await tasks.syncEpics(1, [{ ref: 7, kind: 'epic' }]);
    const epicAttempt = await attempts.createForEpic({ workspaceId: 1, epicRef: 7 });
    const verificationAttempts = new VerificationAttemptStore(db);
    const archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => null });
    const command = { id: 'epic-echo', command: process.execPath, args: ['-e', "console.log('epic-post-merge-out')"], env: {}, timeoutSeconds: 30 };
    const runner = new EpicIntegrationRunner({
      workspace: { id: 1, workingDir: dir },
      worktrees: { release: async () => {} },
      epics: { retireIntegrationBranch: async () => true },
      epicAttempts: attempts,
      verificationAttemptStore: verificationAttempts,
      archive,
      resolvePostMergeCommands: async () => [command],
      mergeEpicIntegration: async (input) => {
        const check = await input.runPostMergeCheck('a'.repeat(40), dir);
        expect(check.pass).toBe(true);
        return { kind: 'merged', mergeOid: 'a'.repeat(40) };
      },
    });

    await runner.integrate({ repoDir: dir, epicRef: 7, defaultBranch: 'main', integrationBranch: 'epic/7' });

    const log = await archive.epicVerificationOutputLog(1, 7, epicAttempt.number, 'epic-echo', 'post-merge');
    expect(readFileSync(log!, 'utf8')).toContain('epic-post-merge-out');
    const recorded = await verificationAttempts.list(epicAttempt.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ mechanism: 'command', verdict: 'pass' });
    void task;
  });
});
