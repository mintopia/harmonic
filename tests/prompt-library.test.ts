import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    expect((await server.api('GET', '/api/prompts/cyc-b')).body.resolved).toBe('x');
    expect((await server.api('GET', '/api/prompts/missing')).status).toBe(404);
  });
});
