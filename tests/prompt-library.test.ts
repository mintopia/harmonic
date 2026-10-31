import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePrompt, validateIncludes } from '../src/domain/prompt-library.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { startServer, type TestServer } from './helpers.js';

describe('include resolution', () => {
  it('expands nested includes', () => {
    const lookup = new Map([
      ['a', 'A[${{ prompts.b }}]'],
      ['b', 'B[${{ prompts.c }}]'],
      ['c', 'C'],
    ]);
    expect(resolvePrompt('${{ prompts.a }} and ${{prompts.c}}', lookup)).toBe('A[B[C]] and C');
  });

  it('refuses a cycle A→B→A naming both codes', () => {
    const others = new Map([['b', 'see ${{ prompts.a }}']]);
    expect(() => validateIncludes({ code: 'a', text: 'see ${{ prompts.b }}' }, others)).toThrow(/Include cycle: a → b → a/);
  });

  it('refuses a self-include and unknown codes', () => {
    expect(() => validateIncludes({ code: 'a', text: '${{ prompts.a }}' }, new Map())).toThrow(/a → a/);
    expect(() => validateIncludes({ code: 'a', text: '${{ prompts.nope }}' }, new Map())).toThrow(/unknown prompt code: nope/);
  });
});

describe('PromptLibrary on a real filesystem', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-prompt-library-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('persists entries to disk and reloads them in a new instance', async () => {
    const first = new PromptLibrary(root);
    await first.create('base', 'shared', 'Hello');
    await first.create('top', 'uses base', 'Say: ${{ prompts.base }}');
    expect(JSON.parse(readFileSync(join(root, 'prompts', 'base.json'), 'utf8'))).toEqual({ description: 'shared', text: 'Hello' });

    const second = new PromptLibrary(root);
    const top = await second.get('top');
    expect(top.resolved).toBe('Say: Hello');
    expect((await second.get('base')).usedBy).toEqual(['top']);
  });

  it('reports the file mtime as updatedAt for operator prompts and null for bundled ones', async () => {
    const lib = new PromptLibrary(root);
    await lib.create('stamped', 'x', 'T');
    expect((await lib.get('stamped')).updatedAt).toBe(statSync(join(root, 'prompts', 'stamped.json')).mtime.toISOString());
    expect((await lib.list()).find((p) => p.bundled)?.updatedAt).toBeNull();
    await lib.delete('stamped');
  });

  it('lists the workflow steps that name a prompt by code, nested and parallel steps included', async () => {
    const lib = new PromptLibrary(root);
    await lib.create('step-used', 'x', 'T');
    const text = `name: wf
description: d
steps:
  - attempts:
      max: 2
      steps:
        - id: build
          uses: agent
          with:
            prompt: step-used
        - id: review
          uses: critic
          with:
            harness: claude
            model: m
            prompt: step-used
        - id: other
          uses: agent
          with:
            prompt: something else
`;
    lib.attachWorkflows({ list: () => [{ name: 'wf', description: 'd', subject: 'ticket' as const, text, bundled: false, version: 1 }] });
    expect((await lib.get('step-used')).usedBySteps).toEqual([
      { workflow: 'wf', workflowBundled: false, stepId: 'build' },
      { workflow: 'wf', workflowBundled: false, stepId: 'review' },
    ]);
    expect((await lib.get('step-used')).usedBy).toEqual([]);
    await lib.delete('step-used');
  });

  it('refuses deleting an included prompt, then deletes once free', async () => {
    const lib = new PromptLibrary(root);
    await expect(lib.delete('base')).rejects.toThrow(/included by: top/);
    await lib.delete('top');
    await lib.delete('base');
    expect(existsSync(join(root, 'prompts', 'base.json'))).toBe(false);
  });
});

describe('/api/prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-prompt-routes-'));
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({}, { dataDir: join(root, 'data') });
  });
  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists bundled prompts, refuses editing one, and duplicates it into an editable copy', async () => {
    const list = await server.api('GET', '/api/prompts');
    expect(list.status).toBe(200);
    const bundled = list.body.prompts.find((p: { code: string }) => p.code === 'conflictResolution');
    expect(bundled.bundled).toBe(true);

    const edit = await server.api('PUT', '/api/prompts/conflictResolution', { description: 'x', text: 'y' });
    expect(edit.status).toBe(403);

    const copy = await server.api('POST', '/api/prompts/conflictResolution/duplicate', {});
    expect(copy.status).toBe(201);
    expect(copy.body.code).toBe('conflictResolution-copy');
    expect(copy.body.bundled).toBe(false);
    expect(copy.body.text).toBe(bundled.text);

    const put = await server.api('PUT', '/api/prompts/conflictResolution-copy', { description: 'mine', text: 'edited' });
    expect(put.status).toBe(200);
    expect(put.body.text).toBe('edited');
  });

  it('keeps Settings and the Library in step for a covered prompt', async () => {
    const patch = await server.api('PATCH', '/api/config', { merge: { conflictPrompt: 'MERGE EDIT {taskBranch}' } });
    expect(patch.status).toBe(200);
    expect((await server.api('GET', '/api/prompts/mergeConflictPrompt-migrated')).body.text).toBe('MERGE EDIT {taskBranch}');

    await server.api('PUT', '/api/prompts/mergeConflictPrompt-migrated', { description: 'x', text: 'LIBRARY EDIT {taskBranch}' });
    expect((await server.api('GET', '/api/config')).body.merge.conflictPrompt).toBe('LIBRARY EDIT {taskBranch}');

    const unrelated = await server.api('PATCH', '/api/config', { maxAttempts: 3 });
    expect(unrelated.body.merge.conflictPrompt).toBe('LIBRARY EDIT {taskBranch}');
    expect((await server.api('GET', '/api/prompts/mergeConflictPrompt-migrated')).body.text).toBe('LIBRARY EDIT {taskBranch}');
  });

  it('refuses a cycle and an unknown include at save', async () => {
    expect((await server.api('POST', '/api/prompts', { code: 'cyc-a', description: '', text: 'x' })).status).toBe(201);
    expect((await server.api('POST', '/api/prompts', { code: 'cyc-b', description: '', text: '${{ prompts.cyc-a }}' })).status).toBe(201);
    const cycle = await server.api('PUT', '/api/prompts/cyc-a', { description: '', text: '${{ prompts.cyc-b }}' });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.message).toContain('cyc-a → cyc-b → cyc-a');
    const unknown = await server.api('POST', '/api/prompts', { code: 'cyc-c', description: '', text: '${{ prompts.ghost }}' });
    expect(unknown.status).toBe(400);
  });

  it('returns the resolved preview and usedBy', async () => {
    const res = await server.api('GET', '/api/prompts/cyc-a');
    expect(res.body.usedBy).toEqual(['cyc-b']);
    expect(res.body.usedBySteps).toEqual([]);
    expect(Number.isNaN(Date.parse(res.body.updatedAt))).toBe(false);
    expect((await server.api('GET', '/api/prompts/cyc-b')).body.resolved).toBe('x');
    expect((await server.api('GET', '/api/prompts/missing')).status).toBe(404);
  });
});
