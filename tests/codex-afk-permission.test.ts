import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, STUB_HARNESS, waitFor, type TestServer } from './helpers.js';
import { workspaces } from '../src/db/schema.js';
import type { MirrorInput } from '../src/domain/tasks.js';

/**
 * Codex has no `auto`/`bypassPermissions` ACP mode (it advertises
 * read-only/agent/agent-full-access), so its afk permission model is
 * "ask-then-remember": `approval_policy: on-request` at spawn, and the Runner
 * auto-grants each request with `allow_always` rather than Escalating. This pins
 * that an unattended Codex Run (a) does NOT die with "no unattended permission
 * mode" and (b) auto-grants the request with the remember option instead of
 * cancelling it.
 */

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const tmpDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-codexperm-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  execFileSync('bash', ['-c', `echo '# repo' > ${join(dir, 'README.md')}`]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Codex afk permission model (ask-then-remember)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({
      ...stubHarness('codex'),
      // Codex advertises no auto/bypass mode — force the stub to match so the
      // afk mode-forcing block takes the auto-grant branch, not the throw.
      harnesses: { codex: { command: process.execPath, args: [STUB_HARNESS], env: { STUB_MODES: 'default,agent,agent-full-access' }, models: ['stub-model'], defaultModel: 'stub-model' } },
      defaults: { harness: 'codex' },
      drive: { autoRetry: 0, continueAttempts: 0 },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  const mirroredAfk = (trackerRef: number): MirrorInput => ({
    trackerRef,
    prompt: 'go',
    workflow: 'implement',
    wayfinderType: null,
    drive: 'afk',
    mapRef: null,
    closed: false,
  });

  it('auto-grants an afk Codex permission request with allow_always instead of Escalating', async () => {
    const repo = makeRepo();
    await server.app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: repo }).run());
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ requestPermission: { title: 'Write hello.txt' }, writeFiles: { 'agent.txt': 'work\n' }, mcpFinish: true, stopReason: 'end_turn' }) },
    });

    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(9310));
    expect(task.harness).toBe('codex');
    await server.app.ctx.tasks.setState(task.id, 'running');
    const run = await server.app.ctx.runner.launchClaimed(task.id);

    const permission = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${run.id}/events`);
      return body.events.find((e: any) => e.type === 'permission_request');
    });

    // Auto-granted with the *remember* option (allow_always), not cancelled —
    // the run never took the Claude-style Escalate-on-request path. Getting a
    // permission_request event at all also proves the afk mode-forcing block did
    // NOT throw "no unattended permission mode" for Codex (it would have failed
    // the run before the prompt turn ever reached the request).
    expect(permission.payload.outcome).toMatchObject({ outcome: 'selected', optionId: 'always' });

    // No request was ever cancelled — the escalate-on-permission branch is Claude-only.
    const { body } = await server.api('GET', `/api/runs/${run.id}/events`);
    const cancelled = body.events.filter((e: any) => e.type === 'permission_request' && e.payload.outcome?.outcome === 'cancelled');
    expect(cancelled).toHaveLength(0);
  });
});
