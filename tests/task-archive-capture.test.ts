import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppConfig, baselineConfig, type DeepPartial } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore } from '../src/domain/sessions.js';
import { TaskService } from '../src/domain/tasks.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { CrashRecoveryCoordinator } from '../src/execution/crash-recovery.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, startServer, type TestServer, waitFor } from './helpers.js';

function archiveDirFor(dataDir: string, taskId: number): string {
  const root = join(dataDir, 'archive');
  for (const slug of readdirSync(root)) {
    const match = readdirSync(join(root, slug)).find((name) => name.startsWith(`${taskId}-`));
    if (match) return join(root, slug, match);
  }
  throw new Error(`no archive dir for task ${taskId}`);
}

describe('Task Archive implementation-Step capture (#728)', () => {
  let server: TestServer;
  const workDir = mkdtempSync(join(tmpdir(), 'harmonic-archive-work-'));
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-archive-native-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-archive-data-'));
  const sessionId = 'archive-native-session';
  const nativeDir = join(logDir, workDir.replace(/[^a-zA-Z0-9]/g, '-'));
  const transcriptPath = join(nativeDir, `${sessionId}.jsonl`);

  beforeAll(async () => {
    server = await startServer(
      {
        defaults: { isolationMode: 'direct' },
        chat: { harness: 'claude', model: 'stub-model' },
        harnesses: {
          claude: {
            command: process.execPath,
            args: [join(import.meta.dirname, 'stub-harness.mjs')],
            models: ['stub-model'],
            defaultModel: 'stub-model',
            sessionLogDir: logDir,
            env: { STUB_SESSION_ID: sessionId },
          },
        },
      } as DeepPartial<AppConfig>,
      { dataDir },
    );
  });

  afterEach(() => {
    rmSync(nativeDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await server?.close();
    for (const dir of [workDir, logDir, dataDir]) rmSync(dir, { recursive: true, force: true });
  });

  async function runToCompletion(prompt: string): Promise<number> {
    const scenario = JSON.stringify({
      prompt,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'archived-output' } }],
    });
    const task = await server.api('POST', '/api/tasks', { prompt: scenario, workingDir: workDir, isolationMode: 'direct' });
    const run = await server.api('POST', `/api/tasks/${task.body.id}/run`);
    await waitFor(async () => ((await server.app.ctx.attempts.get(run.body.id)).state === 'running' ? undefined : true));
    const attempt = await server.app.ctx.attempts.get(run.body.id);
    expect(attempt.state).not.toBe('failed');
    return task.body.id;
  }

  it('writes identity, prompt, ACP updates and the native transcript', async () => {
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(transcriptPath, '{"type":"assistant"}\n');
    const taskId = await runToCompletion('archive me');
    const dir = archiveDirFor(dataDir, taskId);
    expect(existsSync(join(dir, 'archive.json'))).toBe(true);
    const step = join(dir, 'attempts', '1', 'implementation');
    expect(readFileSync(join(step, 'prompt.md'), 'utf8')).toContain('archive me');
    expect(readFileSync(join(step, 'acp.jsonl'), 'utf8')).toContain('archived-output');
    expect(readFileSync(join(step, 'native', `${sessionId}.jsonl`), 'utf8')).toBe('{"type":"assistant"}\n');
  });

  it('still archives prompt and updates when no native transcript exists', async () => {
    const taskId = await runToCompletion('no native');
    const step = join(archiveDirFor(dataDir, taskId), 'attempts', '1', 'implementation');
    expect(readFileSync(join(step, 'prompt.md'), 'utf8')).toContain('no native');
    expect(readFileSync(join(step, 'acp.jsonl'), 'utf8')).toContain('archived-output');
    expect(existsSync(join(step, 'native'))).toBe(false);
  });
});

describe('Task Archive crash recovery (#728)', () => {
  it('copies the native transcript of an interrupted Attempt into the Archive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-archive-crash-'));
    const asyncDb: AsyncDbHandle = await openAsyncDb(dir);
    try {
      await seedWorkspace(asyncDb);
      const settingsStore = await makeSettingsStore(dir);
      const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      const attempts = new AttemptStore(asyncDb);
      const sessions = new SessionStore(asyncDb);
      const settle = new AttemptSettleCoordinator(tasks, attempts);
      const native = join(dir, 'native-session.jsonl');
      writeFileSync(native, 'crash-native\n');
      const created = await tasks.create({ prompt: 'crash', state: 'ready', workingDir: dir, isolationMode: 'direct' });
      await tasks.setState(created.id, 'working');
      const session = await sessions.recordDispatch({
        harness: 'claude', harnessSessionId: 'crash-session', model: 'm', cwd: dir, workspaceId: null,
        transcriptPath: native, mcpTemplates: [], capabilities: undefined, adapterVersion: '0', now: Date.now(),
      });
      const run = await attempts.update((await attempts.create(created.id)).id, { sessionRowId: session.id });
      const archive = new TaskArchive({
        dataDir: dir,
        ensureArchiveId: (id) => tasks.ensureArchiveId(id),
        workspaceName: async () => 'ws',
      });
      const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, {
        runPostMergeCheck: async () => ({ pass: true, output: '' }),
        archive,
        sessionTranscriptPath: async (id) => (await sessions.get(id))?.transcriptPath ?? null,
      });

      await coord.reconcile();

      const copied = join(archiveDirFor(dir, created.id), 'attempts', String(run.number), 'implementation', 'native', 'native-session.jsonl');
      expect(readFileSync(copied, 'utf8')).toBe('crash-native\n');
    } finally {
      await asyncDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
