import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { settings, workspaces } from '../src/db/schema.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { backfillCriticPromptKeys } from '../src/archive/critic-prompt-backfill.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('backfillCriticPromptKeys', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let verificationAttempts: VerificationAttemptStore;

  const archive = () =>
    new TaskArchive({
      dataDir: dir,
      ensureArchiveId: (id) => tasks.ensureArchiveId(id),
      workspaceName: async (id) => (await db.read((d) => d.select().from(workspaces).all())).find((w) => w.id === id)?.name ?? null,
    });

  const criticRun = async (taskId: number, archivedAs: { stage: 'pre-merge' | 'post-merge' } | null) => {
    const task = await tasks.get(taskId);
    const attempt = await attempts.create(taskId);
    const step = await attempts.createStep(attempt.id, { type: 'review' });
    const persisted = await verificationAttempts.append(attempt.id, { mechanism: 'critic', inputOid: 'abc', verdict: 'pass', summary: 's', output: 'o' });
    await attempts.updateStep(step.id, { logLocator: `verification_attempt:${persisted.id}` });
    if (archivedAs) {
      const writer = archive().criticStep(task, attempt.number, archivedAs.stage, String(step.id));
      await writer.appendPrompt('historical critic prompt');
      await writer.close();
    }
    return { persistedId: persisted.id, stepId: step.id };
  };

  const keyOf = async (id: number) => (await verificationAttempts.get(id))?.promptKey ?? null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-backfill-'));
    db = await openAsyncDb(dir);
    await seedWorkspace(db);
    const settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settingsStore));
    attempts = new AttemptStore(db);
    verificationAttempts = new VerificationAttemptStore(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores the key for archived historical prompts of either stage, leaves the rest null, and runs once', async () => {
    const task = await tasks.create({ prompt: 'p' });
    const pre = await criticRun(task.id, { stage: 'pre-merge' });
    const post = await criticRun(task.id, { stage: 'post-merge' });
    const unarchived = await criticRun(task.id, null);
    const deps = { db, archive: archive(), getTask: (id: number) => tasks.get(id) };

    await backfillCriticPromptKeys(deps);

    expect(await keyOf(pre.persistedId)).toBe(`verification/pre-merge/${pre.stepId}/prompt.md`);
    expect(await keyOf(post.persistedId)).toBe(`verification/post-merge/${post.stepId}/prompt.md`);
    expect(await keyOf(unarchived.persistedId)).toBeNull();
    expect(await archive().readArchivedPrompt(await tasks.get(task.id), 1, `verification/pre-merge/${pre.stepId}/prompt.md`)).toBe('historical critic prompt');
    expect((await db.read((d) => d.select().from(settings).where(eq(settings.key, 'migration.critic-prompt-keys')).get()))?.value).toBe('done');

    const late = await criticRun(task.id, { stage: 'pre-merge' });
    await backfillCriticPromptKeys(deps);
    expect(await keyOf(late.persistedId)).toBeNull();
  });

  it('keeps going past a Task that can no longer be read and retries on the next boot instead of marking itself done', async () => {
    const gone = await tasks.create({ prompt: 'gone' });
    const kept = await tasks.create({ prompt: 'kept' });
    const goneRun = await criticRun(gone.id, { stage: 'pre-merge' });
    const keptRun = await criticRun(kept.id, { stage: 'pre-merge' });
    await backfillCriticPromptKeys({ db, archive: archive(), getTask: async (id) => { if (id === gone.id) throw new Error('task unreadable'); return tasks.get(id); } });
    expect(await keyOf(goneRun.persistedId)).toBeNull();
    expect(await keyOf(keptRun.persistedId)).toBe(`verification/pre-merge/${keptRun.stepId}/prompt.md`);
    expect(await db.read((d) => d.select().from(settings).where(eq(settings.key, 'migration.critic-prompt-keys')).get())).toBeUndefined();
    await backfillCriticPromptKeys({ db, archive: archive(), getTask: (id) => tasks.get(id) });
    expect(await keyOf(goneRun.persistedId)).toBe(`verification/pre-merge/${goneRun.stepId}/prompt.md`);
  });
});
