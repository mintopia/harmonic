import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { workspaces } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { baselineConfig, type HarnessConfig } from '../src/config.js';
import { runCritic, type CriticHarnessDrive } from '../src/verification/critic.js';
import type { DriveFields } from '../src/execution/prompt-template.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const FIELDS: DriveFields = { taskId: '77', skill: '/implement', ref: '12', url: '', title: 'T', description: 'D' };

describe('runCritic archive capture', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let logDir: string;

  const harness = (): HarnessConfig => ({
    command: 'unused',
    args: [],
    env: {},
    models: [{ id: 'stub-model' }],
    defaultModel: 'stub-model',
    cacheWarmSeconds: 300,
    sessionLogDir: logDir,
  });

  const archiveFor = () =>
    new TaskArchive({
      dataDir: dir,
      ensureArchiveId: (id) => tasks.ensureArchiveId(id),
      workspaceName: async (id) => (await db.read((d) => d.select().from(workspaces).all())).find((w) => w.id === id)?.name ?? null,
    });

  const drive: CriticHarnessDrive = {
    run: async (req) => {
      req.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
      req.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'c1' });
      return { output: JSON.stringify({ verdict: 'pass', summary: 'ok' }), sessionId: 'sess-1', permissionRequests: [] };
    },
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-archive-'));
    db = await openAsyncDb(dir);
    await seedWorkspace(db);
    const settings = await makeSettingsStore(dir);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settings));
    logDir = join(dir, 'projects');
    mkdirSync(join(logDir, 'proj'), { recursive: true });
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('archives the prompt, updates and a transcript flushed after the drive returns', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const writer = archiveFor().criticStep(task, 1, 'pre-merge', 'critic-1');
    const updates: unknown[] = [];
    setTimeout(() => {
      mkdirSync(join(logDir, 'proj', 'sess-1', 'subagents'), { recursive: true });
      writeFileSync(join(logDir, 'proj', 'sess-1', 'subagents', 'a.jsonl'), 'sub\n');
      writeFileSync(join(logDir, 'proj', 'sess-1.jsonl'), 'root\n');
    }, 150);

    const attempt = await runCritic({
      cwd: dir,
      verifiedHeadOid: 'abc',
      critic: { prompt: 'review it', model: 'stub-model' },
      fields: FIELDS,
      harness: harness(),
      harnessId: 'claude',
      drive,
      archive: writer,
      onUpdate: (u) => updates.push(u),
    });

    expect(attempt.verdict).toBe('pass');
    expect(attempt.transcriptPath).not.toBeNull();
    expect(updates).toHaveLength(2);
    const stepDir = await writer.dir;
    expect(readFileSync(join(stepDir, 'prompt.md'), 'utf8')).toBe(attempt.prompt);
    const lines = readFileSync(join(stepDir, 'acp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.update.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call']);
    expect(readFileSync(join(stepDir, 'native', 'sess-1.jsonl'), 'utf8')).toBe('root\n');
    expect(readFileSync(join(stepDir, 'native', 'sess-1', 'subagents', 'a.jsonl'), 'utf8')).toBe('sub\n');
  });

  it('still archives prompt and updates, without native/, when no transcript ever appears', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const writer = archiveFor().criticStep(task, 1, 'post-merge', 'critic-2');
    const attempt = await runCritic({
      cwd: dir,
      verifiedHeadOid: 'abc',
      critic: { prompt: 'review it', model: 'stub-model' },
      fields: FIELDS,
      harness: harness(),
      harnessId: 'claude',
      drive,
      archive: writer,
      transcriptRetryDelaysMs: [1, 1],
    });
    expect(attempt.verdict).toBe('pass');
    expect(attempt.transcriptPath).toBeNull();
    const stepDir = await writer.dir;
    expect(existsSync(join(stepDir, 'prompt.md'))).toBe(true);
    expect(existsSync(join(stepDir, 'acp.jsonl'))).toBe(true);
    expect(existsSync(join(stepDir, 'native'))).toBe(false);
  });
});
