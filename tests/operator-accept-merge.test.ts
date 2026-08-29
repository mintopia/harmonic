import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { verificationCommandSchema } from '../src/config.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import { mergeJournal } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Relocated from tests/freshness-gate.test.ts when #381 (ADR-0001, the one
 * merge policy) deleted the automated freshness gate / rebase re-entry /
 * carry-forward machinery it used to cover. Operator Accept is untouched by
 * #381 — it is #383's ticket — so its rebase-and-merge and 409-on-conflict
 * behaviour survives here unchanged. The escalated-diff-snapshot case is
 * general (any auto worktree Run), not Accept-specific, but survives for the
 * same reason: nothing about #381 touches it.
 */

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

/** A throwaway git repo on main with a local-markdown tracker declaration (so
 * the auto-merge close resolves a real no-op adapter). */
function makeRepo(): string {
  const dir = tmpPath('harmonic-accept-merge-');
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  mkdirSync(join(dir, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: local-markdown\n\nPath: tickets\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Advance main in the base repo's own (clean, checked-out) working tree. */
function advanceMain(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'main advances independently');
  return git(repo, 'rev-parse', 'main');
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('operator Accept merge (ADR-0043, issue #383)', () => {
  let server: TestServer;
  let wsId: number;

  it('operator Accept on an escalated ticket whose base moved non-conflictingly auto-rebases and merges, without re-verifying (ADR-0043)', async () => {
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    // A verifier that fails: both attempts fail, so the ticket escalates with a
    // real commit as its verified head — Accept has work to merge.
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    // A native worktree Run: its prompt IS the stub scenario.
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    const runId: number = started.body.id;
    const escalated = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });
    expect(escalated.escalationReason).toMatch(/attempt 2 of 2 failed/);
    const verified = (await server.app.ctx.runs.get(runId)).candidateOid;
    expect(verified).toMatch(/^[0-9a-f]{40}$/);

    // The base moves non-conflictingly while the ticket sits escalated — the
    // common case during the operator's review delay.
    const mainTip = advanceMain(repo, 'other.txt', 'someone else merged\n');

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null });

    // main now carries BOTH the independent advance and the replayed
    // implementation, merged as a fast-forward (no merge commit).
    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainTip);
    expect(git(repo, 'show', 'main:other.txt')).toBe('someone else merged');
    expect(git(repo, 'show', 'main:impl-native.txt')).toBe('implementation');
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
    const journal = await server.app.ctx.asyncDb.read((d) => d.select().from(mergeJournal).where(eq(mergeJournal.runId, runId)).all());
    expect(journal.map((row) => row.kind)).toContain('result');
    expect(journal.map((row) => row.kind)).not.toContain('abandoned'); // it merged, not abandoned

    await server.close();
  });

  it('operator Accept still refuses (409) when the base advance conflicts with the candidate, leaving the ticket escalated', async () => {
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' }, maxAttempts: 2 });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;

    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });

    // The base advance touches the SAME file the candidate wrote, so the replay
    // conflicts and there is nothing safe to merge without the operator's help.
    const mainTip = advanceMain(repo, 'impl-native.txt', 'someone else changed this\n');

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(409);
    expect((await server.app.ctx.tasks.get(taskId)).state).toBe('escalated');
    expect(git(repo, 'rev-parse', 'main')).toBe(mainTip); // nothing merged

    await server.close();
  });
});

describe('escalated worktree Run diff snapshot', () => {
  // A Run that escalates still has its work committed on the run branch. The
  // diffstat used to be snapshotted only on the merge path, so an escalated Run
  // persisted none and the review pane went blank exactly when a human needs to
  // see the work. The settle now snapshots the diff on every terminal path.
  // General behaviour, not Accept-specific — untouched by #381.
  it('an escalated worktree Run snapshots its diff so the review pane is never blank', async () => {
    const server = await startServer({
      ...stubHarness(),
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 2,
      drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
    });
    try {
      const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
      const repo = makeRepo();
      await server.app.ctx.workspaces.update(wsId, {
        workingDir: repo,
        maxAttempts: 1,
        verificationCommand: [
          verificationCommandSchema.parse({
            command: process.execPath,
            args: ['-e', 'process.exit(1)'], // a verifier that always fails → escalate at the cap
            timeoutSeconds: 30,
          }),
        ],
      });
      await server.app.ctx.configStore.update({
        drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
      });

      const mirroredAfk = (trackerRef: number): MirrorInput => ({
        trackerRef,
        prompt: `ticket ${trackerRef}\n\nbody`,
        workflow: 'implement',
        wayfinderType: null,
        mapRef: null,
        closed: false,
      });
      const trackerRef = 38_300;
      const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
      seedLocalMarkdownTicket(task.workingDir, trackerRef, 'closed');
      git(task.workingDir, 'add', '-A');
      git(task.workingDir, 'commit', '-q', '-m', `ticket ${trackerRef}`);
      await server.app.ctx.tasks.setState(task.id, 'working');
      const run = await server.app.ctx.runner.launchClaimed(task.id);

      await waitFor(async () => ((await server.app.ctx.tasks.get(task.id)).state === 'escalated' ? true : undefined));

      const settledRun = await server.app.ctx.runs.get(run.id);
      expect(settledRun.state).toBe('failed');
      expect(settledRun.branch).not.toBeNull();
      expect(settledRun.stat).toContain(`impl-${trackerRef}.txt`);
      expect(settledRun.diffBaseOid).not.toBeNull();
      expect(settledRun.diffHeadOid).not.toBeNull();
    } finally {
      await server.close();
    }
  });
});
