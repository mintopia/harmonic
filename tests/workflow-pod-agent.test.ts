import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { SessionStore } from '../src/domain/sessions.js';
import { adapterFor } from '../src/execution/harness/registry.js';
import { PodTranscripts } from '../src/execution/pod-transcript.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import type { PodCredential } from '../src/execution/execution-targets.js';
import { createPodOpener } from '../src/execution/pod-opener.js';
import { CRITIC_CHANGED_THE_WORK, UNCOMMITTED_AFTER_AGENT, WorkflowEngine } from '../src/execution/workflow-engine.js';
import { RepositoryPassService } from '../src/repository-proxy/pass-service.js';
import { createRepositoryProxy } from '../src/repository-proxy/server.js';
import { createAcpCriticDrive } from '../src/verification/critic.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { FakePodApi } from './fake-pod-api.js';
import { allWorkspaces, inBlock, makeSettingsStore, seedWorkspace, testSpawnProcessGroup } from './helpers.js';

const KEY = 'real-git-signing-key';
const TOKEN = 'sk-ant-oat-pod-secret-value';
const AGENT = resolve(import.meta.dirname, 'fixtures/pod-acp-agent.mjs');
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

describe('agent and critic steps in a workflow pod', () => {
  let dir: string;
  let upstream: string;
  let repo: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let proxy: Server;
  let proxyUrl: string;
  let archive: TaskArchive;
  let api: FakePodApi;
  let escalations: string[];
  let completions: number;
  let localDrives: number;

  const engine = (workflow: string, credentials: PodCredential[]): WorkflowEngine => {
    const config = baselineConfig();
    config.harnesses.claude = { ...config.harnesses.claude, command: process.execPath, args: [AGENT] };
    const acp = createAcpCriticDrive(testSpawnProcessGroup);
    return new WorkflowEngine({
      library: { getVersion: async (name, version) => ({ name, description: '', subject: 'ticket' as const, text: workflow, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      secrets: async () => ({}),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      pods: createPodOpener<TaskRow>({
        targets: { podAccess: async () => ({ target: { name: 'kind', namespace: 'agents', cpu: '1', memory: '1Gi', repositoryProxyUrl: proxyUrl, defaultImage: 'img' }, access: { authMethod: 'in-cluster', kubeconfig: null } }), podCredentials: async () => credentials },
        passes: new RepositoryPassService({ reveal: async () => KEY } as never),
        apiFactory: () => api,
        baseBranchFor: async () => 'main',
        setExecution: async () => undefined,
        workdir: join(dir, 'pod-checkout'),
      }),
      podTranscripts: new PodTranscripts<TaskRow>({
        dir: join(dir, 'pod-transcripts'),
        sessions: new SessionStore(db),
        attempts,
        stepRuns: new WorkflowStepRunStore(db),
        archive: (task, run, ref) => archive.stepRun(task as TaskRow, run.number, ref),
        locateDelaysMs: [],
      }),
      agent: {
        drive: { run: async (req) => { if (!req.pod) localDrives += 1; return acp.run(req); } },
        getConfig: () => config,
        prompts: bundledEnginePrompts,
        route: async () => { throw new Error('no route'); },
        resolveOption: async () => { throw new Error('no option'); },
        resolvePrompt: async (text) => text,
        promptFields: async () => ({}) as never,
      },
      escalate: async (_task, _run, reason) => { escalations.push(reason); },
      complete: async () => { completions += 1; },
    });
  };

  const flow = (steps: string): string => `name: flow\ndescription: test\nruns_on: kind\nsteps:\n${inBlock(steps)}`;
  const agentStep = (id: string, extra = ''): string => `  - id: ${id}\n    uses: agent\n    with:\n      harness: claude\n      model: sonnet-5\n      prompt: do the work\n${extra}`;
  async function start() {
    const created = await tasks.create({ prompt: 'p', workflow: 'flow' });
    const task = await tasks.pinWorkflow(created.id, 'flow@1', 'explicit');
    return { task, run: await attempts.create(task.id), branch: `harmonic/task-${task.id}` };
  }
  const rows = async (taskId: number) => new WorkflowStepRunStore(db).listForTask(taskId);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wf-pod-agent-'));
    upstream = join(dir, 'upstream.git');
    repo = join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', '-b', 'main', upstream);
    git(dir, 'clone', '-q', upstream, repo);
    writeFileSync(join(repo, 'base.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    git(repo, 'branch', '-M', 'main');
    proxy = createRepositoryProxy({ key: KEY });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    db = await openAsyncDb(dir);
    await seedWorkspace(db, repo);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, await makeSettingsStore(dir)));
    attempts = new AttemptStore(db);
    archive = new TaskArchive({ dataDir: dir, ensureArchiveId: (id) => tasks.ensureArchiveId(id), workspaceName: async () => 'ws' });
    api = new FakePodApi();
    escalations = [];
    completions = 0;
    localDrives = 0;
  });
  afterEach(() => {
    delete process.env.POD_AGENT_NO_COMMIT;
    proxy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the ACP handshake over the pod stream, lets the agent commit in the pod workdir and pushes the checkpoint', async () => {
    const { task, run, branch } = await start();
    await engine(flow(agentStep('build')), [{ envName: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN }]).run(task, run);

    expect(escalations).toEqual([]);
    expect(completions).toBe(1);
    expect(localDrives).toBe(0);
    expect(api.streams).toHaveLength(1);
    expect(api.streams[0]!.options.cwd).toBe(join(dir, 'pod-checkout'));
    expect(api.streams[0]!.options.env).not.toHaveProperty('HARMONIC_MCP_URL');
    expect(git(upstream, 'log', '--format=%s', `refs/heads/${branch}`)).toBe('agent agent-1.txt\nbase');
    const [row] = await rows(task.id);
    const outputs = JSON.parse(row!.outputs!) as { checkpoint: { sha: string; files: number }; stdout: string };
    expect(row!.outcome).toBe('pass');
    expect(outputs.checkpoint.sha).toBe(git(upstream, 'rev-parse', `refs/heads/${branch}`));
    expect(outputs.checkpoint.files).toBe(1);
  });

  it('mirrors the in-pod session file and records the Session, Archive copy and Usage like a local run', async () => {
    const home = join(dir, 'pod-home');
    mkdirSync(home);
    const env = { HOME: home, POD_AGENT_SESSION: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const { task, run } = await start();
    try {
      await engine(flow(agentStep('build')), [{ envName: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN }]).run(task, run);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env.POD_AGENT_SESSION;
    }

    expect(escalations).toEqual([]);
    const inPod = join(home, '.claude', 'projects', '-pod', 'pod-session.jsonl');
    const source = readFileSync(inPod);
    expect(source.toString('utf8')).toContain('h\u00e9llo \u2713');

    const updated = await attempts.get(run.id);
    expect(updated.sessionId).toBe('pod-session');
    const session = await new SessionStore(db).get(updated.sessionRowId!);
    expect(readFileSync(session!.transcriptPath!).equals(source)).toBe(true);

    const archived = readdirSync(join(dir, 'archive'), { recursive: true, encoding: 'utf8' }).filter((entry) => entry.endsWith(join('native', 'pod-session.jsonl')));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(dir, 'archive', archived[0]!)).equals(source)).toBe(true);

    const expected = adapterFor('claude').usage!.modelsFromSessionLog(inPod, 'pod-session');
    const usage = JSON.parse(updated.usage!) as { models: Record<string, unknown>; totals: unknown };
    expect(expected).toEqual({ 'claude-sonnet-5': { inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 } });
    expect(usage.models).toEqual(expected);
    expect(usage.totals).toMatchObject({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 });
  });

  it('keeps the injected credential out of the transcript, the stored outputs and every exec argument', async () => {
    const { task, run } = await start();
    await engine(flow(agentStep('build')), [{ envName: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN }]).run(task, run);

    const stored = JSON.stringify(await rows(task.id));
    expect(stored).toContain('token=***');
    expect(stored).not.toContain(TOKEN);
    expect(JSON.stringify([api.execs, api.streams])).not.toContain(TOKEN);
  });

  it('escalates without starting the Harness when the target has no credential for the step Harness, and never falls back to local', async () => {
    const { task, run } = await start();
    await engine(flow(agentStep('build') + '  - id: after\n    run: echo after\n'), []).run(task, run);

    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("Target kind has no credential for Harness Claude. Add one in Execution Targets › kind › Credentials, or change the Step's Harness. Harmonic never falls back to local.");
    expect(api.streams).toHaveLength(0);
    expect(localDrives).toBe(0);
    expect(completions).toBe(0);
    expect((await rows(task.id)).map((r) => [r.stepId, r.outcome])).toEqual([['build', 'inconclusive']]);
    expect(api.pods.size + api.secrets.size).toBe(0);
  });

  it('does not retry a missing credential inside the attempts block', async () => {
    const text = `name: flow\ndescription: test\nruns_on: kind\nsteps:\n  - attempts:\n      max: 3\n      steps:\n        - id: build\n          uses: agent\n          with:\n            harness: claude\n            model: sonnet-5\n            prompt: do the work\n`;
    const { task, run } = await start();
    await engine(text, []).run(task, run);
    expect(escalations).toHaveLength(1);
    expect(await rows(task.id)).toHaveLength(1);
  });

  it('fails a critic that changes the pod work it judges, found by the in-pod git marks', async () => {
    process.env.POD_AGENT_NO_COMMIT = '1';
    const critic = '  - id: review\n    uses: critic\n    with:\n      harness: claude\n      model: sonnet-5\n      prompt: review it\n';
    const { task, run } = await start();
    await engine(flow(critic), [{ envName: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN }]).run(task, run);

    expect(api.streams).toHaveLength(1);
    expect(localDrives).toBe(0);
    expect((await rows(task.id)).map((r) => [r.stepId, r.outcome, r.summary])).toEqual([['review', 'fail', CRITIC_CHANGED_THE_WORK]]);
  });

  it('fails an agent turn that leaves uncommitted work in the pod', async () => {
    process.env.POD_AGENT_NO_COMMIT = '1';
    const { task, run } = await start();
    await engine(flow(agentStep('build')), [{ envName: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN }]).run(task, run);
    expect((await rows(task.id)).map((r) => [r.outcome, r.summary])).toEqual([['fail', UNCOMMITTED_AFTER_AGENT]]);
  });
});
