// Merged epic routes/logic suite (integrate decision, merge policy, integrate routes, service
// boundary, read routes, diff, close, stats route, integrate-git). Consolidated so the isolated-pool
// import graph is paid once; each source file's helpers stay block-scoped for byte-identical behavior.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { attempts, type AttemptState, tasks, workspaces } from '../src/db/schema.js';
import { decideEpicIntegrate, type EpicIntegrateFacts, type MemberMergeState } from '../src/domain/epic-integrate-decision.js';
import { type Epic } from '../src/domain/epic-view.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { type PostMergeHook } from '../src/execution/branch-merge.js';
import { EpicCoordinator, type EpicGit, type EpicIntegrate, type EpicIntegrateOutcome, integrationBranchName } from '../src/execution/epic-coordinator.js';
import { type MergePolicyDeps, type MergePolicyOutcome, type PostMergeCheckResult, runMergePolicy } from '../src/execution/merge-policy.js';
import { Runner } from '../src/execution/runner.js';
import { type AttemptUsage } from '../src/execution/usage.js';
import { type SettingsStore } from '../src/server/settings-store.js';
import { type Ticket, type TicketRef, type TrackerAdapter } from '../src/tracker/adapter.js';
import { closeIntegratedEpic, recordAndCloseIntegratedEpic } from '../src/tracker/epic-close.js';
import { TrackerPollerManager } from '../src/tracker/manager.js';
import { type VerificationDecision } from '../src/verification/combine.js';
import { allWorkspaces, captureRunEnv, makeSettingsStore, startServer, stubHarness, type TestServer } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== epic-routes.test.ts =====
{
  // Merged epic routes/logic suite (integrate decision, merge policy, integrate routes, service
  // boundary, read routes, diff, close, stats route). Consolidated so the isolated-pool import graph
  // is paid once; each source file's helpers stay block-scoped for byte-identical behavior.

  // ===== epic-integrate-decision.test.ts =====
  {
    const proceed: VerificationDecision = { outcome: 'proceed', reason: 'all 1 verifier passed' };
    const block: VerificationDecision = { outcome: 'block', reason: 'verifier command failed' };
    const escalate: VerificationDecision = { outcome: 'escalate', reason: 'verifier command inconclusive' };

    const facts = (over: Partial<EpicIntegrateFacts>): EpicIntegrateFacts => ({
      integrationExists: true,
      members: [],
      verification: null,
      force: false,
      ...over,
    });

    const members = (...m: MemberMergeState[]): MemberMergeState[] => m;

    describe('decideEpicIntegrate', () => {
      it('is a noop when the integration branch does not exist (already integrated/retired or never cut)', () => {
        expect(decideEpicIntegrate(facts({ integrationExists: false, members: members('completed') })).action).toBe('noop');
        expect(decideEpicIntegrate(facts({ integrationExists: false, force: true })).action).toBe('noop');
      });

      it('is a noop for an Epic with no members on the automatic path', () => {
        expect(decideEpicIntegrate(facts({ members: [] })).action).toBe('noop');
      });

      describe('automatic path (force=false)', () => {
        it('waits while any member is still pending', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed', 'pending') }));
          expect(d.action).toBe('wait');
        });

        it('blocks the whole Epic when any member cannot merge, even if others completed', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed', 'blocked') }));
          expect(d.action).toBe('blocked');
        });

        it('prefers blocked over wait when both a blocked and a pending member exist', () => {
          const d = decideEpicIntegrate(facts({ members: members('blocked', 'pending') }));
          expect(d.action).toBe('blocked');
        });

        it('asks for verification once every member is completed and none has run yet', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed', 'completed'), verification: null }));
          expect(d.action).toBe('verify');
        });

        it('integrates only when all members completed AND verification proceeds', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed'), verification: proceed }));
          expect(d).toEqual({ action: 'integrate', reason: proceed.reason });
        });

        it('escalates (never integrates) when verification blocks on the integrated whole', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed'), verification: block }));
          expect(d.action).toBe('escalate');
        });

        it('escalates (never integrates) when verification is inconclusive/escalate on the integrated whole', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed'), verification: escalate }));
          expect(d.action).toBe('escalate');
        });
      });

      describe('operator force-integrate-ready-subset (force=true)', () => {
        it('opens the gate despite a blocked member, going straight to verify', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed', 'blocked'), force: true, verification: null }));
          expect(d.action).toBe('verify');
        });

        it('opens the gate despite pending members', () => {
          const d = decideEpicIntegrate(facts({ members: members('pending', 'pending'), force: true, verification: null }));
          expect(d.action).toBe('verify');
        });

        it('still requires a passing verification — a force-integrate does not bypass Verification', () => {
          expect(decideEpicIntegrate(facts({ force: true, verification: block })).action).toBe('escalate');
          expect(decideEpicIntegrate(facts({ force: true, verification: escalate })).action).toBe('escalate');
        });

        it('integrates the subset when verification proceeds', () => {
          const d = decideEpicIntegrate(facts({ members: members('completed', 'blocked'), force: true, verification: proceed }));
          expect(d.action).toBe('integrate');
        });
      });

      it('is total: never throws across the fact space', () => {
        const states: MemberMergeState[] = ['completed', 'blocked', 'pending'];
        const verds: (VerificationDecision | null)[] = [null, proceed, block, escalate];
        for (const integrationExists of [true, false]) {
          for (const force of [true, false]) {
            for (const verification of verds) {
              for (const m of [[] as MemberMergeState[], ...states.map((s) => [s]), states]) {
                expect(() => decideEpicIntegrate({ integrationExists, members: m, verification, force })).not.toThrow();
              }
            }
          }
        }
      });
    });
  }

  // ===== epic-integration-merge-policy.test.ts =====
  {
    describe('Runner.mergeEpicIntegration (epic → develop, ADR-0001 #382)', () => {
      const git = (dir: string, ...args: string[]) =>
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

      let dir: string;
      let repo: string;
      let asyncDb: AsyncDbHandle;
      let settingsStore: SettingsStore;
      let tasks: TaskService;

      beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-integrate-'));
        asyncDb = await openAsyncDb(dir);
        settingsStore = await makeSettingsStore(dir);
        tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
        repo = join(dir, 'repo');
        execFileSync('git', ['init', '-b', 'develop', repo], { encoding: 'utf8' });
        git(repo, 'config', 'user.name', 'Test');
        git(repo, 'config', 'user.email', 'test@example.com');
        writeFileSync(join(repo, 'base.txt'), 'base\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-m', 'init');
        git(repo, 'branch', 'epic/5');
        writeFileSync(join(repo, 'develop.txt'), 'develop advance\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-m', 'develop side');
        const epicWt = join(dir, 'epic-seed');
        git(repo, 'worktree', 'add', epicWt, 'epic/5');
        writeFileSync(join(epicWt, 'epic.txt'), 'epic work\n');
        git(epicWt, 'add', '-A');
        git(epicWt, 'commit', '-m', 'epic side');
        git(repo, 'worktree', 'remove', '--force', epicWt);
      });
      afterEach(async () => {
        await asyncDb.close();
        rmSync(dir, { recursive: true, force: true });
      });

      const makeRunner = (postMerge?: PostMergeHook): Runner =>
        new Runner(tasks, asyncDb, () => baselineConfig(), {
          worktreesDir: join(dir, 'worktrees'),
          criticDrive: { run: async () => ({ output: '', permissionRequests: [] }) },
          ...(postMerge ? { postMerge } : {}),
        });

      const green = async (): Promise<PostMergeCheckResult> => ({ pass: true, output: '' });

      it('merges epic/<ref> into develop with a merge commit and fires the post-merge refresh hook', async () => {
        const refreshed: string[] = [];
        const runner = makeRunner(async ({ baseBranch }) => {
          refreshed.push(baseBranch);
        });

        const outcome = await runner.mergeEpicIntegration({
          workspaceId: 1,
          repoDir: repo,
          epicRef: 5,
          defaultBranch: 'develop',
          integrationBranch: 'epic/5',
          runPostMergeCheck: green,
        });

        expect(outcome.kind).toBe('merged');
        expect(() => git(repo, 'merge-base', '--is-ancestor', 'epic/5', 'develop')).not.toThrow();
        expect(() => git(repo, 'cat-file', '-e', 'develop:epic.txt')).not.toThrow();
        expect(() => git(repo, 'cat-file', '-e', 'develop:develop.txt')).not.toThrow();
        expect(refreshed).toEqual(['develop']);
      });

      it('reverts and escalates (post-merge-red) when the post-merge check fails, leaving develop green', async () => {
        const runner = makeRunner();
        const before = git(repo, 'rev-parse', 'develop');

        const outcome = await runner.mergeEpicIntegration({
          workspaceId: 1,
          repoDir: repo,
          epicRef: 5,
          defaultBranch: 'develop',
          integrationBranch: 'epic/5',
          runPostMergeCheck: async () => ({ pass: false, output: 'suite failed on the merged tip' }),
        });

        expect(outcome).toMatchObject({ kind: 'escalated', reason: 'post-merge-red' });
        expect(() => git(repo, 'cat-file', '-e', 'develop:epic.txt')).toThrow();
        expect(git(repo, 'rev-parse', 'develop')).not.toBe(before);
      });

      it('escalates (conflict) when the epic and develop conflict and resolution is disabled', async () => {
        const conflictRepo = join(dir, 'conflict-repo');
        execFileSync('git', ['init', '-b', 'develop', conflictRepo], { encoding: 'utf8' });
        git(conflictRepo, 'config', 'user.name', 'Test');
        git(conflictRepo, 'config', 'user.email', 'test@example.com');
        writeFileSync(join(conflictRepo, 'shared.txt'), 'base\n');
        git(conflictRepo, 'add', '-A');
        git(conflictRepo, 'commit', '-m', 'init');
        git(conflictRepo, 'branch', 'epic/9');
        writeFileSync(join(conflictRepo, 'shared.txt'), 'develop change\n');
        git(conflictRepo, 'commit', '-am', 'develop side');
        const wt = join(dir, 'epic9-seed');
        git(conflictRepo, 'worktree', 'add', wt, 'epic/9');
        writeFileSync(join(wt, 'shared.txt'), 'epic change\n');
        git(wt, 'commit', '-am', 'epic side');
        git(conflictRepo, 'worktree', 'remove', '--force', wt);

        const runner = makeRunner();
        const outcome = await runner.mergeEpicIntegration({
          workspaceId: 1,
          repoDir: conflictRepo,
          epicRef: 9,
          defaultBranch: 'develop',
          integrationBranch: 'epic/9',
          runPostMergeCheck: green,
        });

        expect(outcome).toMatchObject({ kind: 'escalated', reason: 'conflict' });
        expect(git(conflictRepo, 'status', '--porcelain')).toBe('');
      });

      describe('base-repo restore after a non-default base merge (member → epic/<ref>)', () => {
        const noopDeps: MergePolicyDeps = {
          resolveConflictTurn: async () => {},
          runPostMergeCheck: async () => ({ pass: true, output: '' }),
          escalate: async () => {},
        };

        it('restores the parked default branch after merging a member onto epic/<ref>', async () => {
          const memberWt = join(dir, 'member-seed');
          git(repo, 'worktree', 'add', memberWt, '-b', 'harmonic/task-77', 'epic/5');
          writeFileSync(join(memberWt, 'member.txt'), 'member work\n');
          git(memberWt, 'add', '-A');
          git(memberWt, 'commit', '-m', 'member work');
          git(repo, 'worktree', 'remove', '--force', memberWt);
          expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
          const epicBefore = git(repo, 'rev-parse', 'epic/5');

          const outcome = await runMergePolicy(
            { baseDir: repo, baseBranch: 'epic/5', taskBranch: 'harmonic/task-77', conflictResolveTurns: 0, postMergeCheck: false },
            noopDeps,
          );

          expect(outcome.kind).toBe('merged');
          expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
          expect(git(repo, 'rev-parse', 'epic/5')).not.toBe(epicBefore);
          expect(() => git(repo, 'merge-base', '--is-ancestor', 'harmonic/task-77', 'epic/5')).not.toThrow();
        });

        it('restores the parked branch even when the merge escalates (post-merge-red revert)', async () => {
          const memberWt = join(dir, 'member-seed-2');
          git(repo, 'worktree', 'add', memberWt, '-b', 'harmonic/task-88', 'epic/5');
          writeFileSync(join(memberWt, 'member2.txt'), 'member work\n');
          git(memberWt, 'add', '-A');
          git(memberWt, 'commit', '-m', 'member work');
          git(repo, 'worktree', 'remove', '--force', memberWt);

          const outcome = await runMergePolicy(
            { baseDir: repo, baseBranch: 'epic/5', taskBranch: 'harmonic/task-88', conflictResolveTurns: 0, postMergeCheck: true },
            { ...noopDeps, runPostMergeCheck: async () => ({ pass: false, output: 'red' }) },
          );

          expect(outcome).toMatchObject({ kind: 'escalated', reason: 'post-merge-red' });
          expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
        });
      });
    });
  }

  // ===== epic-integrate-routes.test.ts =====
  {
    async function mcpClient(server: TestServer, token: string): Promise<Client> {
      const client = new Client({ name: 'test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport as any);
      return client;
    }
    const parse = (result: any) => JSON.parse(result.content[0].text);

    describe('Whole-Epic force-integrate operator surface (issue #161)', () => {
      let server: TestServer;

      beforeEach(async () => {
        server = await startServer(stubHarness());
      });
      afterEach(async () => {
        await server.close();
      });

      const ctx = () => server.app.ctx;
      const defaultWorkspaceId = async () => (await ctx().workspaces.list())[0]!.id;

      describe('POST /api/workspaces/:workspaceId/epics/:epicRef/force-integrate', () => {
        it('returns the outcome from TrackerPollerManager.forceIntegrateEpic on a 200', async () => {
          const outcome: EpicIntegrateOutcome = { status: 'integrated', oid: 'deadbeef' };
          const spy = vi.spyOn(ctx().trackerManager, 'forceIntegrateEpic').mockResolvedValue(outcome);

          const res = await server.api('POST', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42/force-integrate`);
          expect(res.status).toBe(200);
          expect(res.body).toEqual(outcome);
          expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()), 42);
        });

        it('passes through a non-integrated outcome (e.g. escalated) unchanged', async () => {
          const outcome: EpicIntegrateOutcome = { status: 'escalated', reason: 'whole-Epic verification failed' };
          vi.spyOn(ctx().trackerManager, 'forceIntegrateEpic').mockResolvedValue(outcome);

          const res = await server.api('POST', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42/force-integrate`);
          expect(res.status).toBe(200);
          expect(res.body).toEqual(outcome);
        });

        it('404s when the Workspace does not exist', async () => {
          const res = await server.api('POST', '/api/workspaces/999999/epics/42/force-integrate');
          expect(res.status).toBe(404);
        });

        it('409s when the Workspace exists but has no active integrate coordinator (tracking off, the default in tests)', async () => {
          const res = await server.api('POST', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42/force-integrate`);
          expect(res.status).toBe(409);
        });

        it('400s on a non-numeric workspaceId or epicRef', async () => {
          expect((await server.api('POST', '/api/workspaces/abc/epics/42/force-integrate')).status).toBe(400);
          expect((await server.api('POST', `/api/workspaces/${(await defaultWorkspaceId())}/epics/xyz/force-integrate`)).status).toBe(400);
        });
      });

      describe('operator-only gating', () => {
        it('denies an attempt-scoped Attempt Key on POST /api/workspaces/:id/epics/:ref/force-integrate', async () => {
          const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
          const token = env.HARMONIC_API_KEY as string;

          const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics/42/force-integrate`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(403);
        });

        it('denies a read-scoped key', async () => {
          const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
          const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics/42/force-integrate`, {
            method: 'POST',
            headers: { authorization: `Bearer ${body.token}` },
          });
          expect(res.status).toBe(403);
        });
      });
    });

    describe('force_integrate_epic MCP tool (issue #161)', () => {
      let server: TestServer;
      let operatorToken: string;

      beforeAll(async () => {
        server = await startServer(stubHarness());
        const key = await server.api('POST', '/api/keys', { name: 'mcp-operator' });
        operatorToken = key.body.token;
      });
      afterAll(async () => {
        await server.close();
      });
      afterEach(() => {
        vi.restoreAllMocks();
      });

      const ctx = () => server.app.ctx;
      const defaultWorkspaceId = async () => (await ctx().workspaces.list())[0]!.id;

      it('is registered and returns the outcome to a full-scope operator key', async () => {
        const client = await mcpClient(server, operatorToken);
        const tools = (await client.listTools()).tools.map((t) => t.name);
        expect(tools).toEqual(expect.arrayContaining(['force_integrate_epic']));

        const outcome: EpicIntegrateOutcome = { status: 'integrated', oid: 'cafef00d' };
        const spy = vi.spyOn(ctx().trackerManager, 'forceIntegrateEpic').mockResolvedValue(outcome);

        const result = parse(
          await client.callTool({
            name: 'force_integrate_epic',
            arguments: { workspaceId: (await defaultWorkspaceId()), epicRef: 7 },
          }),
        );
        expect(result).toEqual(outcome);
        expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()), 7);

        await client.close();
      });

      it('reports a not-found/conflict domain error, not a raw 500, when tracking is off for the Workspace', async () => {
        const client = await mcpClient(server, operatorToken);
        const result = await client.callTool({
          name: 'force_integrate_epic',
          arguments: { workspaceId: (await defaultWorkspaceId()), epicRef: 7 },
        });
        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain('no active whole-Epic integrate coordinator');
        await client.close();
      });

      it('validates its input (rejects a missing epicRef)', async () => {
        const client = await mcpClient(server, operatorToken);
        const result = await client.callTool({
          name: 'force_integrate_epic',
          arguments: { workspaceId: (await defaultWorkspaceId()) },
        });
        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain('epicRef');
        await client.close();
      });

      it('rejects an attempt-scoped Attempt Key with a forbidden domain error, even though /mcp itself admits it', async () => {
        const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
        const runToken = env.HARMONIC_API_KEY as string;

        const client = await mcpClient(server, runToken);
        const forbidden = await client.callTool({
          name: 'force_integrate_epic',
          arguments: { workspaceId: (await defaultWorkspaceId()), epicRef: 7 },
        });
        expect(forbidden.isError).toBe(true);
        expect((forbidden.content as any)[0].text).toContain('forbidden');
        await client.close();
      });
    });
  }

  // ===== epic-service-boundary.test.ts =====
  {
    describe('TrackerPollerManager boundary', () => {
      it('keeps Epic execution dependencies behind EpicService', async () => {
        const source = await readFile(new URL('../src/tracker/manager.ts', import.meta.url), 'utf8');

        expect(source).not.toContain("../execution/git.js");
        expect(source).not.toContain("../execution/epic-");
        expect(source).toContain("./epic-service.js");
      });
    });
  }

  // ===== epic-read-routes.test.ts =====
  {
    describe('Epic read model operator surface (issue #167)', () => {
      let server: TestServer;

      beforeEach(async () => {
        server = await startServer(stubHarness());
      });
      afterEach(async () => {
        await server.close();
      });

      const ctx = () => server.app.ctx;
      const defaultWorkspaceId = async () => (await ctx().workspaces.list())[0]!.id;

      const epic = (over: Partial<Epic> = {}): Epic => ({
        ref: 42,
        title: 'Parallel Epic operator UI',
        kind: 'spec',
        state: 'open',
        description: '',
        createdAt: 0,
        updatedAt: null,
        baseBranch: null,
        dependsOn: [],
        members: [
          {
            ref: 43,
            title: 'Member one',
            taskId: 7,
            state: 'completed',
            escalated: false,
            mergeStatus: 'completed',
            ready: false,
          },
          { ref: 44, title: 'Member two', taskId: null, state: null, escalated: false, mergeStatus: 'pending', ready: true },
        ],
        ready: [44],
        integration: { branch: 'epic/42', exists: true, tip: 'a1b2c3d' },
        verification: { status: null, configured: false },
        integrate: { inFlight: false, held: null, phase: null },
        mergeSteps: [],
        foldedCount: 1,
        memberCount: 2,
        ...over,
      });

      describe('GET /api/workspaces/:workspaceId/epics', () => {
        it('returns { epics } from TrackerPollerManager.listEpics on a 200', async () => {
          const list = [epic()];
          const spy = vi.spyOn(ctx().trackerManager, 'listEpics').mockResolvedValue(list);

          const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics`);
          expect(res.status).toBe(200);
          expect(res.body).toEqual({ epics: list, total: list.length });
          expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()));
        });

        it('returns an empty list rather than erroring when no Epic is derived', async () => {
          vi.spyOn(ctx().trackerManager, 'listEpics').mockResolvedValue([]);
          const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics`);
          expect(res.status).toBe(200);
          expect(res.body).toEqual({ epics: [], total: 0 });
        });

        it('404s when the Workspace does not exist', async () => {
          const res = await server.api('GET', '/api/workspaces/999999/epics');
          expect(res.status).toBe(404);
        });

        it('400s on a non-numeric workspaceId', async () => {
          expect((await server.api('GET', '/api/workspaces/abc/epics')).status).toBe(400);
        });
      });

      describe('GET /api/workspaces/:workspaceId/epics/:epicRef', () => {
        it('returns the Epic from TrackerPollerManager.epicDetail on a 200', async () => {
          const one = epic();
          const spy = vi.spyOn(ctx().trackerManager, 'epicDetail').mockResolvedValue(one);

          const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42`);
          expect(res.status).toBe(200);
          expect(res.body).toEqual(one);
          expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()), 42);
        });

        it('404s when epicDetail resolves null (no such derived Epic)', async () => {
          vi.spyOn(ctx().trackerManager, 'epicDetail').mockResolvedValue(null);
          const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42`);
          expect(res.status).toBe(404);
        });

        it('404s when the Workspace does not exist', async () => {
          const res = await server.api('GET', '/api/workspaces/999999/epics/42');
          expect(res.status).toBe(404);
        });

        it('400s on a non-numeric workspaceId or epicRef', async () => {
          expect((await server.api('GET', '/api/workspaces/abc/epics/42')).status).toBe(400);
          expect((await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/xyz`)).status).toBe(400);
        });
      });

      describe('GET /api/workspaces/:workspaceId/epics/:epicRef/diff/files (ADR-0018, issue #441)', () => {
        it('parses TrackerPollerManager.epicDiff\'s raw unified diff into files, paginated', async () => {
          const raw = [
            'diff --git a/feature.txt b/feature.txt',
            'new file mode 100644',
            'index 0000000..1234567',
            '--- /dev/null',
            '+++ b/feature.txt',
            '@@ -0,0 +1 @@',
            '+added by the epic',
            '',
          ].join('\n');
          const spy = vi.spyOn(ctx().trackerManager, 'epicDiff').mockResolvedValue(raw);

          const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42/diff/files`);
          expect(res.status).toBe(200);
          expect(res.body.total).toBe(1);
          expect(res.body.files).toHaveLength(1);
          expect(res.body.files[0]).toMatchObject({ path: 'feature.txt', status: 'A', additions: 1, deletions: 0 });
          expect(spy).toHaveBeenCalledWith((await defaultWorkspaceId()), 42);
        });

        it('returns an empty files list, not an error, when epicDiff resolves the empty string (branchless/no-op Epic)', async () => {
          vi.spyOn(ctx().trackerManager, 'epicDiff').mockResolvedValue('');
          const res = await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/42/diff/files`);
          expect(res.status).toBe(200);
          expect(res.body).toEqual({ files: [], total: 0 });
        });

        it('404s when the Workspace does not exist', async () => {
          const res = await server.api('GET', '/api/workspaces/999999/epics/42/diff/files');
          expect(res.status).toBe(404);
        });

        it('400s on a non-numeric workspaceId or epicRef', async () => {
          expect((await server.api('GET', '/api/workspaces/abc/epics/42/diff/files')).status).toBe(400);
          expect((await server.api('GET', `/api/workspaces/${(await defaultWorkspaceId())}/epics/xyz/diff/files`)).status).toBe(400);
        });
      });

      describe('operator-only gating', () => {
        it('denies an attempt-scoped Attempt Key on GET /api/workspaces/:id/epics', async () => {
          const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
          const token = env.HARMONIC_API_KEY as string;

          const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(403);
        });

        it('denies an attempt-scoped Attempt Key on GET /api/workspaces/:id/epics/:ref', async () => {
          const { env } = await captureRunEnv(server, ['HARMONIC_API_KEY']);
          const token = env.HARMONIC_API_KEY as string;

          const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics/42`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(403);
        });

        it('denies a read-scoped key on GET /api/workspaces/:id/epics (operator required, not just read)', async () => {
          const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
          const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics`, {
            headers: { authorization: `Bearer ${body.token}` },
          });
          expect(res.status).toBe(403);
        });

        it('denies a read-scoped key on GET /api/workspaces/:id/epics/:ref (operator required, not just read)', async () => {
          const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
          const res = await fetch(`${server.baseUrl}/api/workspaces/${(await defaultWorkspaceId())}/epics/42`, {
            headers: { authorization: `Bearer ${body.token}` },
          });
          expect(res.status).toBe(403);
        });
      });
    });
  }

  // ===== epic-diff.test.ts =====
  {
    function git(dir: string, ...args: string[]): string {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    }

    function makeRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'harmonic-epic-diff-repo-'));
      execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
      git(dir, 'config', 'user.name', 'Test');
      git(dir, 'config', 'user.email', 'test@example.com');
      writeFileSync(join(dir, 'README.md'), '# repo\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'init');
      return dir;
    }

    describe('TrackerPollerManager.epicDiff (ADR-0018, issue #441)', () => {
      let dataDir: string;
      let repo: string;
      let asyncDb: AsyncDbHandle;
      let settingsStore: SettingsStore;
      let tasks: TaskService;
      let workspaces: WorkspaceService;
      let manager: TrackerPollerManager;
      let wsId: number;

      beforeEach(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'harmonic-epic-diff-'));
        repo = makeRepo();
        asyncDb = await openAsyncDb(dataDir);
        settingsStore = await makeSettingsStore(dataDir);
        tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
        workspaces = new WorkspaceService(asyncDb, settingsStore);
        wsId = (await workspaces.create({ name: 'WS', workingDir: repo, trackerEnabled: true })).id;
        manager = new TrackerPollerManager(tasks, () => workspaces.list());
      });

      afterEach(async () => {
        await asyncDb.close();
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      });

      it('an open Epic diffs the live base...epic/<ref> range, showing what the branch adds', async () => {
        const ref = 10;
        git(repo, 'checkout', '-b', integrationBranchName(ref), 'main');
        writeFileSync(join(repo, 'feature.txt'), 'added by the epic\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-m', 'add feature.txt');
        git(repo, 'checkout', 'main');
        await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);

        const raw = await manager.epicDiff(wsId, ref);
        expect(raw).toContain('feature.txt');
        expect(raw).toContain('+added by the epic');
      });

      it('an integrated Epic diffs the frozen merge commit, surviving the branch\'s own retirement', async () => {
        const ref = 11;
        const branch = integrationBranchName(ref);
        git(repo, 'checkout', '-b', branch, 'main');
        writeFileSync(join(repo, 'integrated.txt'), 'landed via the merge commit\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-m', 'epic work');
        git(repo, 'checkout', 'main');
        git(repo, 'merge', '--no-ff', '-m', 'integrate epic', branch);
        const mergeCommit = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'branch', '-D', branch);

        await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);
        await tasks.markEpicIntegrated(wsId, ref, { mergeCommit, memberRefs: [] });

        const raw = await manager.epicDiff(wsId, ref);
        expect(raw).toContain('integrated.txt');
        expect(raw).toContain('+landed via the merge commit');
      });

      it('a branchless/open Epic (no epic/<ref> branch ever cut) yields the empty string, not an error', async () => {
        const ref = 12;
        await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);
        await expect(manager.epicDiff(wsId, ref)).resolves.toBe('');
      });

      it('an integrated no-op Epic (branch already matched base, null merge commit) yields the empty string', async () => {
        const ref = 13;
        await tasks.syncEpics(wsId, [{ ref, kind: 'epic' }]);
        await tasks.markEpicIntegrated(wsId, ref, { mergeCommit: null, memberRefs: [] });
        await expect(manager.epicDiff(wsId, ref)).resolves.toBe('');
      });

      it('an Epic ref with no stored row at all still resolves the live range, and yields empty when the branch is absent', async () => {
        await expect(manager.epicDiff(wsId, 999)).resolves.toBe('');
      });

      it('an unknown workspace yields the empty string rather than throwing', async () => {
        await expect(manager.epicDiff(999_999, 1)).resolves.toBe('');
      });
    });
  }

  // ===== epic-close.test.ts =====
  {
    const ticket = (over: Partial<Ticket> & Pick<Ticket, 'number'>): Ticket => ({
      title: `epic ${over.number}`,
      state: 'open',
      body: '',
      createdAt: '2026-09-01T00:00:00Z',
      closedAt: null,
      labels: ['epic'],
      assignees: [],
      parent: null,
      blockedBy: [],
      blocking: [],
      comments: [],
      isMap: false,
      url: `https://x/${over.number}`,
      ...over,
    });

    const writable = (state: Ticket['state'] = 'open') => {
      const readTicket = vi.fn(async (r: TicketRef) => ticket({ number: r.number, state }));
      const close = vi.fn(async (_r: TicketRef, _comment: string) => {});
      const adapter = { name: 'stub', readTicket, close } as unknown as TrackerAdapter;
      return { adapter, readTicket, close };
    };

    describe('closeIntegratedEpic (#442)', () => {
      it('closes an open Epic issue via the writable adapter, with a comment', async () => {
        const { adapter, close } = writable('open');
        await closeIntegratedEpic(adapter, 42);
        expect(close).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledWith({ number: 42, title: '', state: 'open' }, expect.any(String));
      });

      it('is idempotent: an already-closed issue is not re-closed', async () => {
        const { adapter, readTicket, close } = writable('closed');
        await closeIntegratedEpic(adapter, 42);
        expect(readTicket).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
      });

      it('is a best-effort no-op on an inbound-only tracker (no close capability)', async () => {
        const readTicket = vi.fn(async (r: TicketRef) => ticket({ number: r.number }));
        const adapter = { name: 'freeform', readTicket } as unknown as TrackerAdapter;
        await expect(closeIntegratedEpic(adapter, 42)).resolves.toBeUndefined();
        expect(readTicket).not.toHaveBeenCalled();
      });
    });

    describe('recordAndCloseIntegratedEpic (#442) — the recordIntegration effect', () => {
      it('settles the stored record first, then closes the tracker issue', async () => {
        const order: string[] = [];
        const { adapter, close } = writable('open');
        const settle = vi.fn(async () => {
          order.push('settle');
        });
        close.mockImplementation(async () => {
          order.push('close');
        });
        await recordAndCloseIntegratedEpic({ epicRef: 42, settle, resolveAdapter: async () => adapter, onError: () => {} });
        expect(settle).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['settle', 'close']);
      });

      it('is best-effort: a close/resolve failure is reported but never undoes the settle', async () => {
        const settle = vi.fn(async () => {});
        const onError = vi.fn<(msg: string) => void>();
        await expect(
          recordAndCloseIntegratedEpic({
            epicRef: 42,
            settle,
            resolveAdapter: async () => {
              throw new Error('tracker unreachable');
            },
            onError,
          }),
        ).resolves.toBeUndefined();
        expect(settle).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('42'));
      });

      it('propagates a settle failure (an unrecorded integrate is a retryable miss, not a close)', async () => {
        const { adapter, close } = writable('open');
        const settle = vi.fn(async () => {
          throw new Error('db down');
        });
        await expect(
          recordAndCloseIntegratedEpic({ epicRef: 42, settle, resolveAdapter: async () => adapter, onError: () => {} }),
        ).rejects.toThrow('db down');
        expect(close).not.toHaveBeenCalled();
      });
    });
  }

  // ===== epic-stats-route.test.ts =====
  {
    describe('GET /api/epics/:ref/stats', () => {
      let server: TestServer;
      let nextAttemptNumber = 1;

      beforeAll(async () => {
        server = await startServer();
      });
      afterAll(async () => {
        await server.close();
      });

      const cost = (usd: number | null, model = 'sonnet-5'): string =>
        JSON.stringify({ totalUsd: usd, byModel: { [model]: usd }, incomplete: usd === null });

      const usageJson = (usage: Partial<AttemptUsage>): string =>
        JSON.stringify({
          models: {},
          totals: null,
          toolCalls: {},
          source: 'session-log',
          ...usage,
        } satisfies AttemptUsage);

      const seedEpicChildTask = async (mapRef: number, prompt = `epic ${mapRef} child`): Promise<number> => {
        const created = await server.api('POST', '/api/tasks', { prompt });
        const taskId = created.body.id as number;
        await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ mapRef }).where(eq(tasks.id, taskId)).run());
        return taskId;
      };

      const seedEpicChildTaskInWorkspace = async (workspaceId: number, mapRef: number): Promise<number> => {
        const now = Date.now();
        const row = await server.app.ctx.asyncDb.write((d) =>
          d
            .insert(tasks)
            .values({
              prompt: `epic ${mapRef} child (workspace ${workspaceId})`,
              workingDir: '/other-epic-workspace',
              state: 'ready',
              workspaceId,
              mapRef,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get(),
        );
        return row.id;
      };

      const seedAttempt = async (
        taskId: number,
        r: { state: AttemptState; startedAt: number; endedAt: number | null; cost?: string | null; usage?: string | null },
      ) => {
        const number = nextAttemptNumber++;
        return server.app.ctx.asyncDb.write((d) =>
          d
            .insert(attempts)
            .values({
              taskId,
              number,
              state: r.state,
              startedAt: r.startedAt,
              endedAt: r.endedAt,
              cost: r.cost ?? null,
              usage: r.usage ?? null,
            })
            .returning()
            .get(),
        );
      };

      describe('scope isolation and shape', () => {
        let epic100TaskId: number;
        let epic200TaskId: number;

        beforeAll(async () => {
          epic100TaskId = await seedEpicChildTask(100);
          epic200TaskId = await seedEpicChildTask(200);

          await seedAttempt(epic100TaskId, {
            state: 'passed',
            startedAt: 1_000,
            endedAt: 2_000,
            cost: cost(2),
            usage: usageJson({
              totals: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150 },
            }),
          });
          await seedAttempt(epic100TaskId, {
            state: 'passed',
            startedAt: 3_000,
            endedAt: 4_000,
            cost: cost(3),
            usage: usageJson({
              totals: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 300 },
            }),
          });

          await seedAttempt(epic200TaskId, {
            state: 'passed',
            startedAt: 1_000,
            endedAt: 2_000,
            cost: cost(9_999),
            usage: usageJson({
              totals: { inputTokens: 50_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100_000 },
            }),
          });
        });

        it('scopes attemptCount, cost, and tokens to the epic ref — the other epic never leaks in', async () => {
          const { status, body } = await server.api('GET', '/api/epics/100/stats?from=0');
          expect(status).toBe(200);
          expect(body.attemptCount).toBe(2);
          expect(body.cost?.totalUsd).toBeCloseTo(5);
          expect(body.totals?.inputTokens).toBe(300);
          expect(body.totals?.outputTokens).toBe(150);
        });

        it('scopes byWorkspace to only the epic ref\'s own Tasks', async () => {
          const { body } = await server.api('GET', '/api/epics/100/stats?from=0');
          expect(body.byWorkspace).toHaveLength(1);
          expect(body.byWorkspace[0]).toMatchObject({ tasks: 1 });
          expect(body.byWorkspace[0].cost?.totalUsd).toBeCloseTo(5);
        });

        it('the sibling epic (200) sees only its own attempt, not epic 100\'s', async () => {
          const { body } = await server.api('GET', '/api/epics/200/stats?from=0');
          expect(body.attemptCount).toBe(1);
          expect(body.cost?.totalUsd).toBeCloseTo(9_999);
        });

        it('returns the same response shape as the fleet /api/stats surface', async () => {
          const fleet = await server.api('GET', '/api/stats?from=0');
          const epic = await server.api('GET', '/api/epics/100/stats?from=0');
          expect(fleet.status).toBe(200);
          expect(epic.status).toBe(200);
          const sharedKeys = [
            'attemptCount',
            'attemptsByState',
            'failedAttempts',
            'durationMs',
            'totals',
            'models',
            'cost',
            'series',
            'tasksMergedByDay',
            'attemptsPerTask',
            'costPerMergedTask',
            'verdicts',
            'gateOutcomes',
            'guardrailTrips',
            'byWorkspace',
          ];
          for (const key of sharedKeys) {
            expect(fleet.body).toHaveProperty(key);
            expect(epic.body).toHaveProperty(key);
          }
        });
      });

      describe('empty / unknown epic', () => {
        it('reports honest numbers — never a fabricated 0 or a fake cost — for an epic with no child Tasks', async () => {
          const { status, body } = await server.api('GET', '/api/epics/999999/stats?from=0');
          expect(status).toBe(200);
          expect(body.attemptCount).toBe(0);
          expect(body.cost).toBeNull();
          expect(body.durationMs).toBeNull();
        });
      });

      describe('optional workspaceId narrowing', () => {
        let defaultWorkspaceId: number;
        let otherWorkspaceId: number;

        beforeAll(async () => {
          defaultWorkspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
          otherWorkspaceId = (
            await server.app.ctx.asyncDb.write((d) =>
              d
                .insert(workspaces)
                .values({ name: 'Other workspace', workingDir: '/epic-stats-other-workspace', createdAt: Date.now(), updatedAt: Date.now() })
                .returning()
                .get(),
            )
          ).id;

          const defaultTaskId = await seedEpicChildTask(300, 'epic 300 child (default workspace)');
          const otherTaskId = await seedEpicChildTaskInWorkspace(otherWorkspaceId, 300);

          await seedAttempt(defaultTaskId, { state: 'passed', startedAt: 1_000, endedAt: 2_000, cost: cost(7) });
          await seedAttempt(otherTaskId, { state: 'passed', startedAt: 1_000, endedAt: 2_000, cost: cost(70) });
        });

        it('narrows to the default Workspace\'s child Task when workspaceId is given', async () => {
          const { body } = await server.api('GET', `/api/epics/300/stats?from=0&workspaceId=${defaultWorkspaceId}`);
          expect(body.attemptCount).toBe(1);
          expect(body.cost?.totalUsd).toBeCloseTo(7);
        });

        it('narrows to the other Workspace\'s child Task when workspaceId is given', async () => {
          const { body } = await server.api('GET', `/api/epics/300/stats?from=0&workspaceId=${otherWorkspaceId}`);
          expect(body.attemptCount).toBe(1);
          expect(body.cost?.totalUsd).toBeCloseTo(70);
        });

        it('spans every Workspace holding a ref-300 child when workspaceId is omitted', async () => {
          const { body } = await server.api('GET', '/api/epics/300/stats?from=0');
          expect(body.attemptCount).toBe(2);
          expect(body.cost?.totalUsd).toBeCloseTo(77);
        });
      });

      describe('validation', () => {
        it('rejects a non-numeric :ref with a 400 validation envelope', async () => {
          const res = await server.api('GET', '/api/epics/not-a-number/stats');
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ error: { code: 'validation' } });
        });
      });
    });
  }
}

// ===== epic-integrate-git.test.ts =====
{
  const proceed: VerificationDecision = { outcome: 'proceed', reason: 'all 1 verifier passed' };
  const block: VerificationDecision = { outcome: 'block', reason: 'verifier command failed' };
  const inconclusive: VerificationDecision = { outcome: 'escalate', reason: 'verifier inconclusive' };

  class FakeGit implements Pick<EpicGit, 'branchExists' | 'revParse' | 'symbolicBranch' | 'isAncestor' | 'isContentContained'> {
    readonly contained: Set<string> = new Set();
    readonly contentContained: Set<string> = new Set();
    constructor(
      readonly branches: Set<string> = new Set(['epic/42']),
      private readonly tips: Map<string, string> = new Map([['epic/42', 'oid-epic-42']]),
      private defaultBranch: string | null = 'develop',
    ) {}
    async branchExists(_dir: string, name: string): Promise<boolean> {
      return this.branches.has(name);
    }
    async revParse(_dir: string, rev: string): Promise<string> {
      return this.tips.get(rev) ?? `oid-${rev}`;
    }
    async symbolicBranch(): Promise<string | null> {
      return this.defaultBranch;
    }
    async isAncestor(_dir: string, _baseBranch: string, branch: string): Promise<boolean> {
      return this.contained.has(branch);
    }
    async isContentContained(_dir: string, _baseBranch: string, branch: string): Promise<boolean> {
      return this.contentContained.has(branch);
    }
    setDefaultBranch(b: string | null): void {
      this.defaultBranch = b;
    }
    setContained(branch: string): void {
      this.contained.add(branch);
    }
    setContentContained(branch: string): void {
      this.contentContained.add(branch);
    }
  }

  const merged = (mergeOid = 'integrated-oid'): MergePolicyOutcome => ({ kind: 'merged', mergeOid });

  type VerifyFn = (args: { repoDir: string; verifiedHeadOid: string }) => Promise<VerificationDecision>;

  const build = (opts: {
    git?: FakeGit;
    verify?: VerifyFn;
    integrate?: EpicIntegrate;
    now?: () => number;
    verifyBackoffMs?: number;
    operationTimeoutMs?: number;
  } = {}) => {
    const git = opts.git ?? new FakeGit();
    const verify = vi.fn<VerifyFn>(opts.verify ?? (async () => proceed));
    const integrate = vi.fn<EpicIntegrate>(opts.integrate ?? (async () => merged()));
    const retire = vi.fn(async (_ref: number) => {});
    const escalate = vi.fn<(epicRef: number, reason: string) => void>();
    const recordIntegration = vi.fn(async (_input: { epicRef: number; mergeCommit: string | null; memberRefs: number[] }) => {});
    const onError = vi.fn<(msg: string) => void>();
    let t = 0;
    const coord = new EpicCoordinator({
      repoDir: '/repo',
      git,
      verify,
      integrate,
      retire,
      escalate,
      now: opts.now ?? (() => (t += 600_000)),
      ...(opts.verifyBackoffMs !== undefined ? { verifyBackoffMs: opts.verifyBackoffMs } : {}),
      ...(opts.operationTimeoutMs !== undefined ? { operationTimeoutMs: opts.operationTimeoutMs } : {}),
      recordIntegration,
      onError,
    });
    return { coord, git, verify, integrate, retire, escalate, recordIntegration, onError };
  };

  const members = (...m: MemberMergeState[]): MemberMergeState[] => m;

  describe('EpicCoordinator', () => {
    it('is a noop when the integration branch is gone (already integrated/retired)', async () => {
      const { coord, verify, integrate } = build({ git: new FakeGit(new Set()) });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out).toEqual({ status: 'noop', reason: expect.any(String) });
      expect(verify).not.toHaveBeenCalled();
      expect(integrate).not.toHaveBeenCalled();
    });

    it('waits (no verify, no integrate) while a member is still pending', async () => {
      const { coord, verify, integrate } = build();
      const out = await coord.submit({ ref: 42, members: members('completed', 'pending') });
      expect(out.status).toBe('waiting');
      expect(verify).not.toHaveBeenCalled();
      expect(integrate).not.toHaveBeenCalled();
    });

    it('blocks (no verify, no integrate, no escalate) when a member cannot merge', async () => {
      const { coord, verify, integrate, escalate } = build();
      const out = await coord.submit({ ref: 42, members: members('completed', 'blocked') });
      expect(out.status).toBe('blocked');
      expect(verify).not.toHaveBeenCalled();
      expect(integrate).not.toHaveBeenCalled();
      expect(escalate).not.toHaveBeenCalled();
    });

    it('integrates + retires only when all members completed AND verification proceeds', async () => {
      const { coord, verify, integrate, retire, escalate } = build();
      const out = await coord.submit({ ref: 42, members: members('completed', 'completed') });
      expect(out).toEqual({ status: 'integrated', oid: 'integrated-oid' });
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({ verifiedHeadOid: 'oid-epic-42' }));
      expect(integrate).toHaveBeenCalledWith(expect.objectContaining({ repoDir: '/repo', epicRef: 42, defaultBranch: 'develop', integrationBranch: 'epic/42' }));
      expect(retire).toHaveBeenCalledWith(42);
      expect(escalate).not.toHaveBeenCalled();
    });

    it('records the real merge-commit + member snapshot on a successful integrate (#438)', async () => {
      const { coord, recordIntegration } = build();
      const out = await coord.submit({ ref: 42, members: members('completed', 'completed'), memberRefs: [11, 12] });
      expect(out).toEqual({ status: 'integrated', oid: 'integrated-oid' });
      expect(recordIntegration).toHaveBeenCalledWith({ epicRef: 42, mergeCommit: 'integrated-oid', memberRefs: [11, 12] });
    });

    it('records a null merge-commit (no-op) when the branch is already contained in base (#438)', async () => {
      const git = new FakeGit();
      git.setContained('epic/42');
      const { coord, integrate, recordIntegration } = build({ git });
      const out = await coord.submit({ ref: 42, members: members('completed'), memberRefs: [7] });
      expect(out).toEqual({ status: 'integrated', oid: 'oid-epic-42' });
      expect(integrate).not.toHaveBeenCalled();
      expect(recordIntegration).toHaveBeenCalledWith({ epicRef: 42, mergeCommit: null, memberRefs: [7] });
    });

    it('defers the branch retire when the integration record fails, so the next poll can re-settle (#438)', async () => {
      const git = new FakeGit();
      const { coord, retire, recordIntegration, onError } = build({ git });
      recordIntegration.mockRejectedValueOnce(new Error('db down'));
      const out = await coord.submit({ ref: 42, members: members('completed'), memberRefs: [11] });
      expect(out).toEqual({ status: 'integrated', oid: 'integrated-oid' });
      expect(retire).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('integration snapshot record failed'));
    });

    it('escalates and never merges when the integrated whole fails verification', async () => {
      const { coord, integrate, retire, escalate } = build({ verify: async () => block });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('escalated');
      expect(integrate).not.toHaveBeenCalled();
      expect(retire).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('verification'));
    });

    it('escalates on an inconclusive/escalate whole-Epic verdict (fail-safe)', async () => {
      const { coord, integrate, escalate } = build({ verify: async () => inconclusive });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('escalated');
      expect(integrate).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalled();
    });

    it('escalates (never merges) when the verification harness itself throws', async () => {
      const { coord, integrate, escalate } = build({
        verify: async () => {
          throw new Error('worktree add failed');
        },
      });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('escalated');
      expect(integrate).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('could not run'));
    });

    it('escalates and frees the in-flight guard when a verification hangs past the operation timeout', async () => {
      const { coord, integrate, escalate } = build({
        verify: () => new Promise<never>(() => {}), // never resolves
        operationTimeoutMs: 20,
      });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('escalated');
      expect(integrate).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('timed out'));
      expect(coord.isInFlight(42)).toBe(false);
    });

    it('escalates when the integrate itself hangs past the operation timeout', async () => {
      const { coord, escalate } = build({
        integrate: () => new Promise<never>(() => {}), // never resolves
        operationTimeoutMs: 20,
      });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('escalated');
      expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('could not run'));
      expect(coord.isInFlight(42)).toBe(false);
    });

    it('escalates when the integrate escalates (unresolved conflict / red post-merge check)', async () => {
      const { coord, retire, escalate } = build({
        integrate: async () => ({ kind: 'escalated', reason: 'conflict', message: 'a human needs to resolve them' }),
      });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('escalated');
      expect(retire).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('conflict'));
    });

    it('escalates (with the revert recorded) when the post-merge check is red', async () => {
      const { coord, escalate } = build({
        integrate: async () => ({ kind: 'escalated', reason: 'post-merge-red', message: 'the merge was reverted so the base stays green', revertOid: 'revert-oid' }),
      });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('escalated');
      expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('post-merge-red'));
    });

    it('defers (waiting, no integrate) when the default branch is detached', async () => {
      const git = new FakeGit();
      git.setDefaultBranch(null);
      const { coord, integrate } = build({ git });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('waiting');
      expect(integrate).not.toHaveBeenCalled();
    });

    it('stays integrated when retire fails after a successful integrate (non-fatal, logged)', async () => {
      const onError = vi.fn<(msg: string) => void>();
      const coordWithBadRetire = new EpicCoordinator({
        repoDir: '/repo',
        git: new FakeGit(),
        verify: async () => proceed,
        integrate: async () => merged(),
        retire: async () => {
          throw new Error('branch -d failed');
        },
        escalate: vi.fn(),
        onError,
      });
      const out = await coordWithBadRetire.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('integrated');
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('retire'));
    });

    describe('containment fast-path (#218)', () => {
      it('retires (no verify, no integrate) when the integration branch is already contained in the default branch', async () => {
        const git = new FakeGit();
        git.setContained('epic/42');
        const { coord, verify, integrate, retire } = build({ git });
        const out = await coord.submit({ ref: 42, members: members('completed', 'completed') });
        expect(out).toEqual({ status: 'integrated', oid: 'oid-epic-42' });
        expect(verify).not.toHaveBeenCalled();
        expect(integrate).not.toHaveBeenCalled();
        expect(retire).toHaveBeenCalledWith(42);
      });

      it('stays a success when the retire of an already-contained branch fails (logged, non-fatal)', async () => {
        const git = new FakeGit();
        git.setContained('epic/42');
        const onError = vi.fn<(msg: string) => void>();
      const coord = new EpicCoordinator({
          repoDir: '/repo',
          git,
          verify: async () => proceed,
          integrate: async () => merged(),
          retire: async () => {
            throw new Error('branch -d failed');
          },
          escalate: vi.fn(),
          onError,
        });
        const out = await coord.submit({ ref: 42, members: members('completed') });
        expect(out.status).toBe('integrated');
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('already-contained'));
      });

      it('retires a squash/rebase-merged branch whose content is contained but tip is not an ancestor (tier 2, #218)', async () => {
        const git = new FakeGit();
        git.setContentContained('epic/42');
        const { coord, verify, integrate, retire } = build({ git });
        const out = await coord.submit({ ref: 42, members: members('completed', 'completed') });
        expect(out).toEqual({ status: 'integrated', oid: 'oid-epic-42' });
        expect(verify).not.toHaveBeenCalled();
        expect(integrate).not.toHaveBeenCalled();
        expect(retire).toHaveBeenCalledWith(42);
      });

      it('holds the tier-2 content check behind the backoff (not run every poll)', async () => {
        let clock = 0;
        const git = new FakeGit();
        const isContentContained = vi.spyOn(git, 'isContentContained');
        const { coord } = build({ git, verify: async () => inconclusive, now: () => clock, verifyBackoffMs: 60_000 });
        await coord.submit({ ref: 42, members: members('completed') });
        expect(isContentContained).toHaveBeenCalledTimes(1);
        clock = 30_000;
        await coord.submit({ ref: 42, members: members('completed', 'completed') });
        expect(isContentContained).toHaveBeenCalledTimes(1);
      });

      it('keeps the backoff when a contained-branch retire fails, so tier 2 does not re-run every poll (#218)', async () => {
        let clock = 0;
        const git = new FakeGit();
        git.setContentContained('epic/42');
        const isContentContained = vi.spyOn(git, 'isContentContained');
        const retire = vi.fn(async (_ref: number) => {
          throw new Error('branch -d failed');
        });
        const onError = vi.fn<(msg: string) => void>();
      const coord = new EpicCoordinator({
          repoDir: '/repo',
          git,
          verify: async () => proceed,
          integrate: async () => merged(),
          retire,
          escalate: vi.fn(),
          now: () => clock,
          verifyBackoffMs: 60_000,
          onError,
        });
        const first = await coord.submit({ ref: 42, members: members('completed') });
        expect(first.status).toBe('integrated');
        expect(isContentContained).toHaveBeenCalledTimes(1);
        expect(retire).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('already-contained'));
        clock = 30_000;
        const second = await coord.submit({ ref: 42, members: members('completed') });
        expect(second.status).toBe('waiting');
        expect(isContentContained).toHaveBeenCalledTimes(1);
        expect(retire).toHaveBeenCalledTimes(1);
      });

      it('retains the last verification verdict on the containment fast-path (read-model consistency, #218)', async () => {
        const git = new FakeGit();
        const { coord } = build({ git });
        await coord.submit({ ref: 42, members: members('completed') });
        expect(coord.verificationStatus(42)).toBe('pass');
        git.setContained('epic/42');
        const out = await coord.submit({ ref: 42, members: members('completed') });
        expect(out.status).toBe('integrated');
        expect(coord.verificationStatus(42)).toBe('pass');
      });

      it('auto-retires an already-contained branch even if it was previously escalated (clears the sticky hold)', async () => {
        const git = new FakeGit();
        const { coord, verify, retire } = build({ git, verify: async () => block });
        const first = await coord.submit({ ref: 42, members: members('completed') });
        expect(first.status).toBe('escalated');
        expect(retire).not.toHaveBeenCalled();
        git.setContained('epic/42');
        const out = await coord.submit({ ref: 42, members: members('completed') });
        expect(out).toEqual({ status: 'integrated', oid: 'oid-epic-42' });
        expect(retire).toHaveBeenCalledWith(42);
        expect(verify).toHaveBeenCalledTimes(1);
      });
    });

    describe('hard verify+integrate backoff (#218)', () => {
      it('defers a repeat verify+integrate within the backoff window (no re-burn)', async () => {
        let clock = 0;
        const { coord, verify } = build({ verify: async () => inconclusive, now: () => clock, verifyBackoffMs: 60_000 });
        const first = await coord.submit({ ref: 42, members: members('completed') });
        expect(first.status).toBe('escalated');
        clock = 30_000;
        const second = await coord.submit({ ref: 42, members: members('completed', 'completed') });
        expect(second.status).toBe('waiting');
        expect(verify).toHaveBeenCalledTimes(1);
      });

      it('allows the next verify+integrate once the backoff window elapses', async () => {
        let clock = 0;
        const { coord, verify } = build({ verify: async () => inconclusive, now: () => clock, verifyBackoffMs: 60_000 });
        await coord.submit({ ref: 42, members: members('completed') });
        clock = 60_001;
        await coord.submit({ ref: 42, members: members('completed', 'completed') });
        expect(verify).toHaveBeenCalledTimes(2);
      });

      it('an operator force-integrate bypasses the backoff', async () => {
        let clock = 0;
        const { coord, verify } = build({
          verify: vi.fn<VerifyFn>().mockResolvedValueOnce(inconclusive).mockResolvedValue(proceed),
          now: () => clock,
          verifyBackoffMs: 60_000,
        });
        const first = await coord.submit({ ref: 42, members: members('completed') });
        expect(first.status).toBe('escalated');
        clock = 10_000;
        const forced = await coord.submit({ ref: 42, members: members('completed') }, { force: true });
        expect(forced.status).toBe('integrated');
        expect(verify).toHaveBeenCalledTimes(2);
      });
    });

    describe('operator force-integrate-ready-subset', () => {
      it('integrates the subset past a blocked member when verification proceeds', async () => {
        const { coord, integrate, retire } = build();
        const out = await coord.submit({ ref: 42, members: members('completed', 'blocked') }, { force: true });
        expect(out.status).toBe('integrated');
        expect(integrate).toHaveBeenCalled();
        expect(retire).toHaveBeenCalledWith(42);
      });

      it('still escalates on a failing verification — force does not bypass Verification', async () => {
        const { coord, integrate, escalate } = build({ verify: async () => block });
        const out = await coord.submit({ ref: 42, members: members('completed', 'blocked') }, { force: true });
        expect(out.status).toBe('escalated');
        expect(integrate).not.toHaveBeenCalled();
        expect(escalate).toHaveBeenCalled();
      });

      it('is still a noop with no integration branch to merge', async () => {
        const { coord, verify } = build({ git: new FakeGit(new Set()) });
        const out = await coord.submit({ ref: 42, members: [] }, { force: true });
        expect(out.status).toBe('noop');
        expect(verify).not.toHaveBeenCalled();
      });
    });

    describe('sticky escalation (level-trigger terminal guard)', () => {
      it('does not re-run Verification or re-escalate on repeated polls once escalated for the same member state', async () => {
        const { coord, verify, escalate } = build({ verify: async () => block });
        const target = { ref: 42, members: members('completed', 'completed') };
        const first = await coord.submit(target);
        expect(first.status).toBe('escalated');
        const second = await coord.submit(target);
        const third = await coord.submit(target);
        expect(second.status).toBe('escalated');
        expect(third.status).toBe('escalated');
        expect(verify).toHaveBeenCalledTimes(1);
        expect(escalate).toHaveBeenCalledTimes(1);
      });

      it('re-attempts once the member-state signature changes', async () => {
        const { coord, verify } = build({ verify: async () => block });
        await coord.submit({ ref: 42, members: members('completed', 'completed') });
        expect(verify).toHaveBeenCalledTimes(1);
        await coord.submit({ ref: 42, members: members('completed', 'completed', 'completed') });
        expect(verify).toHaveBeenCalledTimes(2);
      });

      it('clears the hold when the integration branch is gone, then starts clean', async () => {
        const git = new FakeGit(new Set(['epic/42']));
        const { coord, verify } = build({ git, verify: async () => block });
        await coord.submit({ ref: 42, members: members('completed') });
        expect(verify).toHaveBeenCalledTimes(1);
        git.branches.delete('epic/42');
        const gone = await coord.submit({ ref: 42, members: members('completed') });
        expect(gone.status).toBe('noop');
        git.branches.add('epic/42');
        await coord.submit({ ref: 42, members: members('completed') });
        expect(verify).toHaveBeenCalledTimes(2);
      });

      it('an operator force-integrate always retries past a sticky escalation', async () => {
        const { coord, verify, integrate } = build({
          verify: vi
            .fn<VerifyFn>()
            .mockResolvedValueOnce(block)
            .mockResolvedValue(proceed),
        });
        await coord.submit({ ref: 42, members: members('completed') });
        const forced = await coord.submit({ ref: 42, members: members('completed') }, { force: true });
        expect(forced.status).toBe('integrated');
        expect(verify).toHaveBeenCalledTimes(2);
        expect(integrate).toHaveBeenCalledTimes(1);
      });
    });

    describe('retained verification status (issue #178)', () => {
      it('is null before any attempt', () => {
        const { coord } = build();
        expect(coord.verificationStatus(42)).toBeNull();
      });

      it('is pass after a successful merge', async () => {
        const { coord } = build();
        await coord.submit({ ref: 42, members: members('completed', 'completed') });
        expect(coord.verificationStatus(42)).toBe('pass');
      });

      it('is fail after a blocking verdict', async () => {
        const { coord } = build({ verify: async () => block });
        await coord.submit({ ref: 42, members: members('completed') });
        expect(coord.verificationStatus(42)).toBe('fail');
      });

      it('is fail after an inconclusive verdict', async () => {
        const { coord } = build({ verify: async () => inconclusive });
        await coord.submit({ ref: 42, members: members('completed') });
        expect(coord.verificationStatus(42)).toBe('fail');
      });

      it('is fail after the verification harness throws', async () => {
        const { coord } = build({
          verify: async () => {
            throw new Error('boom');
          },
        });
        await coord.submit({ ref: 42, members: members('completed') });
        expect(coord.verificationStatus(42)).toBe('fail');
      });

      it('is pending while a verify is in flight, then pass once it resolves', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { coord } = build({
          verify: async () => {
            await gate;
            return proceed;
          },
        });
        const submitted = coord.submit({ ref: 42, members: members('completed') });
        await new Promise((r) => setTimeout(r, 0));
        expect(coord.verificationStatus(42)).toBe('pending');
        release();
        await submitted;
        expect(coord.verificationStatus(42)).toBe('pass');
      });

      it('clears to null once the integration branch is gone', async () => {
        const git = new FakeGit(new Set(['epic/42']));
        const { coord } = build({ git });
        await coord.submit({ ref: 42, members: members('completed') });
        expect(coord.verificationStatus(42)).toBe('pass');
        git.branches.delete('epic/42');
        await coord.submit({ ref: 42, members: members('completed') });
        expect(coord.verificationStatus(42)).toBeNull();
      });
    });

    it('short-circuits a concurrent re-submit for the same Epic to busy', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { coord } = build({
        verify: async () => {
          await gate;
          return proceed;
        },
      });
      const first = coord.submit({ ref: 42, members: members('completed') });
      const second = await coord.submit({ ref: 42, members: members('completed') });
      expect(second).toEqual({ status: 'busy' });
      release();
      expect((await first).status).toBe('integrated');
    });
  });
}
