import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { resolveVars, resolveVarSources, validateVarOverrides } from '../src/domain/workflow-vars.js';
import { defaultHint, overridesFrom, parseVarInput, resetRow, setRowValue, ticketInherited, ticketVarRows, withWorkflowOverrides, workspaceVarRows } from '../web/src/components/workflow-vars-model.js';
import { addVar, overriddenIn, readRunsOn, readVars, removeVar, setVar } from '../web/src/workflow-yaml-vars-model.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const defaults = { maxAttempts: 2, mode: 'fast', strict: false };

describe('workflow var resolution', () => {
  it('uses the workflow default when nothing overrides it', () => {
    expect(resolveVars(defaults, null, null)).toEqual(defaults);
  });

  it('prefers a Workspace override to the default', () => {
    expect(resolveVars(defaults, { maxAttempts: 4 }, null)).toEqual({ ...defaults, maxAttempts: 4 });
  });

  it('prefers a Ticket override to a Workspace override', () => {
    expect(resolveVars(defaults, { maxAttempts: 4, mode: 'slow' }, { maxAttempts: 7 })).toEqual({ maxAttempts: 7, mode: 'slow', strict: false });
  });

  it('reports which level each value came from', () => {
    const sources = resolveVarSources(defaults, { mode: 'slow' }, { maxAttempts: 7 });
    expect(Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.source]))).toEqual({ maxAttempts: 'ticket', mode: 'workspace', strict: 'default' });
  });

  it('skips an override that no longer fits the pinned version', () => {
    expect(resolveVars(defaults, null, { maxAttempts: 'many', gone: 1 })).toEqual(defaults);
  });

  it('keeps a falsy override', () => {
    expect(resolveVars(defaults, null, { strict: false, maxAttempts: 0 })).toMatchObject({ maxAttempts: 0 });
  });
});

describe('validateVarOverrides', () => {
  it('accepts values of the default\'s type', () => {
    expect(validateVarOverrides(defaults, { maxAttempts: 3, mode: 'x', strict: true })).toEqual([]);
  });

  it('refuses a type mismatch without coercing', () => {
    expect(validateVarOverrides(defaults, { maxAttempts: '3', strict: 'true' })).toEqual(['maxAttempts: expected number, got string', 'strict: expected boolean, got string']);
  });

  it('refuses an undeclared name, including prototype keys', () => {
    expect(validateVarOverrides(defaults, { nope: 1 })).toEqual(['nope: the workflow declares no such var']);
    expect(validateVarOverrides(defaults, { constructor: 'x' })).toHaveLength(1);
  });
});

describe('workflow vars model layer', () => {
  const defaults = { maxAttempts: 3, continueAttempts: true, testCommand: 'npm test' };

  describe('workflow vars model', () => {
    it('builds Workspace rows with type and source', () => {
      const rows = workspaceVarRows(defaults, { maxAttempts: 5, continueAttempts: 'no' as unknown as boolean });
      expect(rows.map((r) => [r.name, r.type, r.value, r.source])).toEqual([
        ['maxAttempts', 'number', 5, 'workspace'],
        ['continueAttempts', 'boolean', true, 'default'],
        ['testCommand', 'string', 'npm test', 'default'],
      ]);
    });

    it('types input by the default without coercion', () => {
      expect(parseVarInput('maxAttempts', 3, '5')).toEqual({ ok: true, value: 5 });
      expect(parseVarInput('maxAttempts', 3, 'three')).toEqual({ ok: false, message: 'maxAttempts must be a number (the workflow default is 3).' });
      expect(parseVarInput('maxAttempts', 3, '')).toMatchObject({ ok: false });
      expect(parseVarInput('flag', true, 'false')).toEqual({ ok: true, value: false });
      expect(parseVarInput('flag', true, 'yes')).toMatchObject({ ok: false });
      expect(parseVarInput('cmd', 'npm test', '3')).toEqual({ ok: true, value: '3' });
    });

    it('a value equal to the inherited one clears the override; Reset restores it', () => {
      const [row] = workspaceVarRows(defaults, null);
      const set = setRowValue(row!, 5, 'workspace');
      expect(set.source).toBe('workspace');
      expect(setRowValue(set, 3, 'workspace').source).toBe('default');
      expect(resetRow(set)).toMatchObject({ value: 3, source: 'default' });
    });

    it('Ticket rows inherit the Workspace value', () => {
      const vars = [{ name: 'maxAttempts', default: 3, workspace: 5, ticket: 2, value: 2, source: 'ticket' as const }];
      const [row] = ticketVarRows(vars);
      expect(defaultHint(vars[0]!)).toBe('3 ← Workspace 5');
      expect(resetRow(row!, ticketInherited(vars[0]!))).toMatchObject({ value: 5, source: 'workspace' });
      expect(setRowValue(row!, 3, 'ticket', ticketInherited(vars[0]!)).source).toBe('ticket');
      expect(overridesFrom([row!], 'ticket')).toEqual({ maxAttempts: 2 });
    });

    it('writes and prunes per-workflow overrides', () => {
      const one = withWorkflowOverrides(null, 'wf', { a: 1 });
      expect(one).toEqual({ wf: { a: 1 } });
      expect(withWorkflowOverrides(one, 'other', { b: true })).toEqual({ wf: { a: 1 }, other: { b: true } });
      expect(withWorkflowOverrides(one, 'wf', {})).toBeNull();
    });
  });
});

const SAMPLE = `name: w
description: d
runs_on: kind
vars:
  # keep: retries are costly
  max_loops: 3
  strict: true
  branch: main
steps:
  - id: a
    run: "true"
`;

describe('workflow yaml vars model', () => {
  it('reads declared vars with their types and runs_on', () => {
    expect(readVars(SAMPLE)).toEqual([
      { name: 'max_loops', type: 'number', value: '3' },
      { name: 'strict', type: 'boolean', value: 'true' },
      { name: 'branch', type: 'string', value: 'main' },
    ]);
    expect(readRunsOn(SAMPLE)).toBe('kind');
    expect(readVars('name: [')).toEqual([]);
  });

  it('sets a default keeping its type and the surrounding comments', () => {
    const next = setVar(SAMPLE, 'max_loops', '5');
    expect(next).toContain('max_loops: 5');
    expect(next).toContain('# keep: retries are costly');
    expect(setVar(SAMPLE, 'strict', 'false')).toContain('strict: false');
    expect(setVar(SAMPLE, 'max_loops', 'abc')).toContain('max_loops: abc');
  });

  it('adds and removes vars, creating and dropping the vars map', () => {
    const added = addVar(SAMPLE, 'extra', 'x');
    expect(readVars(added).map((v) => v.name)).toContain('extra');
    const bare = 'name: w\ndescription: d\nsteps:\n  - id: a\n    run: "true"\n';
    expect(readVars(addVar(bare, 'first', '1'))).toEqual([{ name: 'first', type: 'number', value: '1' }]);
    const gone = removeVar(addVar(bare, 'first', '1'), 'first');
    expect(gone).not.toContain('vars:');
    expect(removeVar(SAMPLE, 'branch')).not.toContain('branch');
  });

  it('refuses to add a duplicate and leaves invalid text alone', () => {
    expect(addVar(SAMPLE, 'branch', 'x')).toBe(SAMPLE);
    expect(setVar('name: [', 'a', '1')).toBe('name: [');
  });

  it('lists the workspaces that override a var', () => {
    const workspaces: { name: string; workflowVars: Record<string, Record<string, string>> | null }[] = [
      { name: 'api', workflowVars: { w: { branch: 'dev' } } },
      { name: 'web', workflowVars: { other: { branch: 'x' } } },
      { name: 'ops', workflowVars: null },
    ];
    expect(overriddenIn('w', 'branch', workspaces)).toEqual(['api']);
    expect(overriddenIn('w', 'strict', workspaces)).toEqual([]);
  });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const tries = `name: tries\ndescription: test\nvars:\n  maxAttempts: 1\n  tag: plain\nsteps:\n  - attempts:\n      max: \${{ vars.maxAttempts }}\n      steps:\n        - id: nope\n          run: exit 1\n`;

describe('workflow var overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-vars-'));
  const repo = join(root, 'repo');
  let server: TestServer;
  let workspaceId: number;

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    server = await startServer(stubHarness(), { dataDir: join(root, 'data') });
    await server.api('PUT', '/api/workflows/tries', { text: tries });
    workspaceId = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;
  });
  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const create = async () => (await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree', workflow: 'tries' })).body.id as number;
  const vars = async (id: number) => (await server.api('GET', `/api/tasks/${id}/workflow-vars`)).body;
  const attemptRuns = async (id: number) => (await server.api('GET', `/api/tasks/${id}/workflow-steps`)).body.steps.length as number;

  it('refuses Workspace overrides with a wrong type or an undeclared name', async () => {
    expect((await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { tries: { maxAttempts: '3' } } })).status).toBe(400);
    expect((await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { tries: { nope: 1 } } })).status).toBe(400);
    expect((await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { missing: { a: 1 } } })).status).toBe(400);
  });

  it('applies Ticket over Workspace over default, at the pin', async () => {
    const saved = await server.api('PATCH', `/api/workspaces/${workspaceId}`, { workflowVars: { tries: { maxAttempts: 2 } } });
    expect(saved.status).toBe(200);
    expect(saved.body.workflowVars).toEqual({ tries: { maxAttempts: 2 } });

    const workspaceOnly = await create();
    expect((await vars(workspaceOnly)).vars).toEqual([
      { name: 'maxAttempts', default: 1, workspace: 2, ticket: null, value: 2, source: 'workspace' },
      { name: 'tag', default: 'plain', workspace: null, ticket: null, value: 'plain', source: 'default' },
    ]);
    await server.api('POST', `/api/tasks/${workspaceOnly}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${workspaceOnly}`)).body.state === 'escalated');
    expect(await attemptRuns(workspaceOnly)).toBe(2);
    expect((await server.api('GET', `/api/tasks/${workspaceOnly}`)).body.workflowVars).toEqual({ maxAttempts: 2, tag: 'plain' });

    const ticket = await create();
    const put = await server.api('PUT', `/api/tasks/${ticket}/workflow-vars`, { vars: { maxAttempts: 3 } });
    expect(put.status).toBe(200);
    expect(put.body.vars[0]).toMatchObject({ ticket: 3, value: 3, source: 'ticket' });
    await server.api('POST', `/api/tasks/${ticket}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${ticket}`)).body.state === 'escalated');
    expect(await attemptRuns(ticket)).toBe(3);
  });

  it('refuses Ticket overrides with a wrong type or an undeclared name', async () => {
    const id = await create();
    expect((await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { maxAttempts: '5' } })).status).toBe(400);
    expect((await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { nope: 5 } })).status).toBe(400);
    expect((await vars(id)).vars[0].ticket).toBeNull();
  });

  it('clears Ticket overrides with an empty object', async () => {
    const id = await create();
    await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { maxAttempts: 9 } });
    const cleared = await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: {} });
    expect(cleared.body.vars[0]).toMatchObject({ ticket: null, source: 'workspace' });
  });

  it('refuses an override the Ticket\'s resolved workflow does not declare', async () => {
    const id = (await server.api('POST', '/api/tasks', { prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' })).body.id as number;
    expect((await server.api('PUT', `/api/tasks/${id}/workflow-vars`, { vars: { a: 1 } })).status).toBe(400);
  });
});
