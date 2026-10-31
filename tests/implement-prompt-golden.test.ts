import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { resolveRoute } from '../src/domain/route.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { renderAgentPrompt } from '../src/execution/prompt-assembly.js';
import { appendFeedback, driveFields } from '../src/execution/prompt-template.js';
import { WorkflowEngine } from '../src/execution/workflow-engine.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, testSpawnProcessGroup } from './helpers.js';
import { buildOldImplementPrompts, FEEDBACK, HEAL, NATIVE_TASK, TICKET_TASK, TICKET_URL } from './helpers/implement-golden-fixtures.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/implement-prompt-golden.json', import.meta.url), 'utf8')) as Record<string, string>;
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('implement prompt golden (today path)', () => {
  it('assembles byte-for-byte the recorded prompts from the existing prompt functions', () => {
    expect(buildOldImplementPrompts()).toEqual(golden);
  });
});

describe('implement prompt golden (bundled Library entries)', () => {
  const library = new PromptLibrary(null);
  const urlFor = () => TICKET_URL;
  const native = { prompt: NATIVE_TASK.prompt, id: NATIVE_TASK.id, workingDir: NATIVE_TASK.workingDir, harness: NATIVE_TASK.harness, model: NATIVE_TASK.model };
  const ticket = (task: typeof TICKET_TASK = TICKET_TASK) => ({ ...native, ...driveFields(task as never, urlFor), feedback: '' });
  const render = async (code: string, fields: Record<string, string | number>): Promise<string> => renderAgentPrompt(await library.resolve(code), fields);
  const withFeedback = (fields: Record<string, string | number>) => ({ ...fields, feedback: appendFeedback('', FEEDBACK) });
  const heal = { attempt: HEAL.attempt, reason: HEAL.reason, output: HEAL.output };

  it.each([
    ['nativeFirst', 'implement-native', { ...native, feedback: '' }],
    ['nativeFeedback', 'implement-native', withFeedback(native)],
    ['ticketFirst', 'implement-ticket', ticket()],
    ['ticketFeedback', 'implement-ticket', withFeedback(ticket())],
    ['ticketCodex', 'implement-ticket', ticket({ ...TICKET_TASK, harness: 'codex' })],
    ['nativeHeal', 'implement-native-heal', { ...native, feedback: '', ...heal }],
    ['ticketHeal', 'implement-ticket-heal', { ...ticket(), ...heal }],
    ['commitNudge', 'commitNudge', {}],
  ] as const)('renders %s from %s', async (key, code, fields) => {
    expect(await render(code, fields)).toBe(golden[key]);
  });
});

describe('bundled implement workflow through the engine', () => {
  let dir: string;
  let repo: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let prompts: PromptLibrary;
  let driven: string[];
  let turns: ((cwd: string, n: number) => void)[];
  let verifyFails: number;
  let escalations: string[];

  const commitFile = (cwd: string, name: string): void => {
    writeFileSync(join(cwd, name), name);
    git(cwd, 'add', name);
    git(cwd, 'commit', '-q', '-m', name);
  };

  const run = async (over: Partial<TaskRow>) => {
    const created = await tasks.create({ prompt: String(over.prompt), workflow: 'implement' });
    const task = { ...(await tasks.pinWorkflow(created.id, 'implement@1', 'explicit')), ...over } as TaskRow;
    const attempt = await attempts.create(task.id);
    const config = { ...baselineConfig(), harnesses: { claude: { command: 'x', args: [], env: {}, models: [{ id: 'm' }], defaultModel: 'm', cacheWarmSeconds: 300 } } } as unknown as ReturnType<typeof baselineConfig>;
    const fields = (t: TaskRow) => driveFields({ ...t, id: TICKET_TASK.id, trackerRef: TICKET_TASK.trackerRef, mapRef: null } as never, urlFor);
    const urlFor = () => TICKET_URL;
    const engine = new WorkflowEngine({
      library: new WorkflowLibrary(null),
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      commandById: async () => undefined,
      preMergeCommands: async () => (verifyFails-- > 0 ? [{ id: 'v', command: 'sh', args: ['-c', 'echo O; exit 1'], env: {}, timeoutSeconds: 30 }] : []),
      postMergeCommands: async () => [],
      secrets: async () => ({}),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      agent: {
        drive: { run: async (req) => { driven.push(req.prompt); turns[driven.length - 1]?.(req.cwd, driven.length); return { output: '', sessionId: 's', permissionRequests: [] }; } },
        getConfig: () => config,
        route: async () => resolveRoute(config, 'claude', 'm', null),
        resolvePrompt: (text) => prompts.resolve(text),
        promptFields: async (t) => fields(t),
      },
      escalate: async (_t, _r, reason) => { escalations.push(reason); },
      closeTicket: async () => true,
      complete: async () => undefined,
    });
    await engine.run(task, attempt);
    return { task, rows: await new WorkflowStepRunStore(db).listForTask(task.id) };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-golden-engine-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    db = await openAsyncDb(dir);
    await seedWorkspace(db, repo);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, await makeSettingsStore(dir)));
    attempts = new AttemptStore(db);
    prompts = new PromptLibrary(null);
    driven = [];
    turns = [(cwd) => writeFileSync(join(cwd, 'a.txt'), 'dirty'), (cwd) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'work'); }];
    verifyFails = 0;
    escalations = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sends the native opening prompt, then the commit nudge', async () => {
    const { rows } = await run({ prompt: NATIVE_TASK.prompt, origin: 'native', feedback: null });
    expect(driven).toEqual([golden.nativeFirst, golden.commitNudge]);
    expect(rows.find((r) => r.stepId === 'build')!.resolvedPrompt).toBe(golden.nativeFirst);
    expect(escalations).toEqual([]);
  });

  it('sends the mirrored opening prompt with feedback, then the commit nudge', async () => {
    const { rows } = await run({ prompt: TICKET_TASK.prompt, origin: 'mirrored', trackerRef: String(TICKET_TASK.trackerRef) as TaskRow['trackerRef'], feedback: FEEDBACK });
    expect(driven).toEqual([golden.ticketFeedback, golden.commitNudge]);
    expect(rows.find((r) => r.stepId === 'build')!.resolvedPrompt).toBe(golden.ticketFeedback);
  });

  it('sends the mirrored opening prompt and the codex skill byte for byte', async () => {
    await run({ prompt: TICKET_TASK.prompt, origin: 'mirrored', trackerRef: String(TICKET_TASK.trackerRef) as TaskRow['trackerRef'], feedback: null });
    expect(driven).toEqual([golden.ticketFirst, golden.commitNudge]);
    driven = [];
    await run({ prompt: TICKET_TASK.prompt, origin: 'mirrored', harness: 'codex', trackerRef: String(TICKET_TASK.trackerRef) as TaskRow['trackerRef'], feedback: null });
    expect(driven[0]).toBe(golden.ticketCodex);
  });

  it.each([
    ['native', 'nativeHeal', { prompt: NATIVE_TASK.prompt, origin: 'native' as const }],
    ['mirrored', 'ticketHeal', { prompt: TICKET_TASK.prompt, origin: 'mirrored' as const, trackerRef: String(TICKET_TASK.trackerRef) as TaskRow['trackerRef'] }],
  ])('sends the %s self-heal prompt on the second attempt byte for byte against the old assembly', async (_kind, key, over) => {
    verifyFails = 1;
    turns[2] = (cwd) => commitFile(cwd, 'b.txt');
    const { rows } = await run({ ...over, feedback: null });
    expect(driven).toHaveLength(3);
    const failed = rows.find((r) => r.stepId === 'verify' && r.outcome === 'fail')!;
    const expected = buildOldImplementPrompts({ attempt: 1, reason: `workflow step verify fail: ${failed.summary}`, output: 'O\n' })[key];
    expect(driven[2]).toBe(expected);
    expect(driven[2]!.startsWith(golden[key === 'nativeHeal' ? 'nativeFirst' : 'ticketFirst']!)).toBe(true);
  });
});
