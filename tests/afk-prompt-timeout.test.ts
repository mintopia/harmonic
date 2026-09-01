import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import type { MirrorInput } from '../src/domain/tasks.js';

/**
 * Issue #426 — the live incident (tasks 410/411): an afk agent called
 * finish_task and then its `session/prompt` response was never delivered, so
 * the drive loop blocked at `await driver.prompt()` and only the 60-minute
 * wall-clock guardrail escalated it. With the per-turn ACP inactivity bound the
 * silent turn ends, and — because finish_task was signalled — the run proceeds
 * to verification and merges, rather than hanging until the wall-clock trip.
 */

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

function makeRepo(): string {
  const dir = tmpPath('harmonic-afk-timeout-');
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

describe('afk drive loop — finish_task + lost prompt response → verify, not a 60m escalation (issue #426)', () => {
  let server: TestServer;
  let wsId: number;
  let ref = 42_600;

  beforeAll(async () => {
    server = await startServer({
      ...stubHarness(),
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 2,
      // A short per-turn inactivity bound so the silent turn ends in seconds
      // rather than waiting for the 60m wall-clock guardrail. The wall-clock
      // budget stays at its 60m default: if the fix regressed, the test would
      // time out at its own `waitFor` bound, never merge.
      guardrails: { promptInactivityTimeoutMinutes: 0.05 },
      drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
    });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;
  });
  afterAll(async () => {
    await server.close();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  const mirroredAfk = (trackerRef: number): MirrorInput => ({
    trackerRef,
    prompt: `ticket ${trackerRef}\n\nbody`,
    workflow: 'implement',
    wayfinderType: null,
    mapRef: null,
    closed: false,
  });

  it('ends the silent turn, verifies the finished candidate, and merges to done', async () => {
    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo });
    const trackerRef = ref++;
    // The agent commits its work, signals finish_task, then its prompt response
    // is never delivered (`exit: hang`) — the exact 410/411 shape.
    await server.app.ctx.settingsStore.updateGlobal({
      drive: {
        prompt: JSON.stringify({
          writeFiles: { 'impl.txt': 'implementation\n' },
          mcpFinish: true,
          exit: 'hang',
        }),
      },
    });

    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
    seedLocalMarkdownTicket(task.workingDir, trackerRef, 'closed');
    git(task.workingDir, 'add', '-A');
    git(task.workingDir, 'commit', '-q', '-m', `ticket ${trackerRef}`);
    await server.app.ctx.tasks.setState(task.id, 'working');
    const attemptId = (await server.app.ctx.runner.launchClaimed(task.id)).id;

    const done = await waitFor(
      async () => {
        const t = await server.app.ctx.tasks.get(task.id);
        if (t.state === 'escalated')
          throw new Error(`escalated instead of merging: ${(await server.app.ctx.attempts.get(attemptId)).reason}`);
        return t.state === 'done' ? t : undefined;
      },
      { timeoutMs: 25_000 },
    );
    expect(done.state).toBe('done');
    expect(git(repo, 'show', 'main:impl.txt')).toBe('implementation');

    const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events
      .filter((e: { type: string }) => e.type === 'lifecycle')
      .map((e: { payload: { event: string } }) => e.payload.event);
    // The turn ended on the inactivity bound, and the wall-clock guardrail
    // never tripped.
    expect(events).toContain('turn-timeout');
    expect(events).not.toContain('guardrail-tripped');
  }, 40_000);

  it('a finished turn whose stdout EOFs (connection gone) still verifies and merges to done', async () => {
    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo });
    const trackerRef = ref++;
    // The agent commits, signals finish_task, then its inner process closes
    // stdout (EOF) while an outer wrapper lingers — the connection is gone, so
    // the turn cannot be re-prompted; the finished candidate is verified anyway.
    await server.app.ctx.settingsStore.updateGlobal({
      drive: {
        prompt: JSON.stringify({
          writeFiles: { 'impl.txt': 'implementation\n' },
          mcpFinish: true,
          exit: 'close-stdout',
        }),
      },
    });

    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
    seedLocalMarkdownTicket(task.workingDir, trackerRef, 'closed');
    git(task.workingDir, 'add', '-A');
    git(task.workingDir, 'commit', '-q', '-m', `ticket ${trackerRef}`);
    await server.app.ctx.tasks.setState(task.id, 'working');
    const attemptId = (await server.app.ctx.runner.launchClaimed(task.id)).id;

    const done = await waitFor(
      async () => {
        const t = await server.app.ctx.tasks.get(task.id);
        if (t.state === 'escalated')
          throw new Error(`escalated instead of merging: ${(await server.app.ctx.attempts.get(attemptId)).reason}`);
        return t.state === 'done' ? t : undefined;
      },
      { timeoutMs: 25_000 },
    );
    expect(done.state).toBe('done');
    expect(git(repo, 'show', 'main:impl.txt')).toBe('implementation');

    const events = (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events
      .filter((e: { type: string }) => e.type === 'lifecycle')
      .map((e: { payload: { event: string } }) => e.payload.event);
    expect(events).toContain('turn-eof');
    expect(events).not.toContain('guardrail-tripped');
  }, 40_000);
});
