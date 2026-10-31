import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { startServer, type TestServer } from './helpers.js';

const flow = (name: string, extra = '') => `name: ${name}
description: A test flow
steps:
  - id: build
    run: npm test
${extra}`;

describe('/api/workflows', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-routes-'));
  const dataDir = join(root, 'data');
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({}, { dataDir });
  });
  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses an invalid save with line and column and writes nothing', async () => {
    const res = await server.api('PUT', '/api/workflows/broken', { text: 'name: broken\ndescription: x\nsteps:\n  - id: build\n    run: npm test\n    bogus: 1\n' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([expect.objectContaining({ line: 6, column: 5 })]);
    expect(existsSync(join(dataDir, 'workflows', 'broken.yaml'))).toBe(false);
    expect(existsSync(join(dataDir, 'workflows', '.versions', 'broken'))).toBe(false);
  });

  it('reports a YAML syntax error with its position', async () => {
    const res = await server.api('PUT', '/api/workflows/syntax', { text: 'name: syntax\nsteps: [\n' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].line).toBeGreaterThan(0);
  });

  it('imports a file and exports the identical bytes', async () => {
    const text = `# my comment\n${flow('imported')}`;
    const imported = await server.api('POST', '/api/workflows/import', { text });
    expect(imported.status).toBe(201);
    const exported = await fetch(`${server.baseUrl}/api/workflows/imported/export`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
    expect(await exported.text()).toBe(text);
    expect(readFileSync(join(dataDir, 'workflows', 'imported.yaml'), 'utf8')).toBe(text);
  });

  it('keeps bundled workflows read-only and duplicates them into editable copies', async () => {
    expect((await server.api('PUT', '/api/workflows/implement', { text: flow('implement') })).status).toBe(403);
    const copy = await server.api('POST', '/api/workflows/implement/duplicate', {});
    expect(copy.status).toBe(201);
    expect(copy.body.name).toBe('implement-copy');
    expect(copy.body.bundled).toBe(false);
  });
});

describe('WorkflowLibrary on a real filesystem', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-library-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('leaves the previous file intact when a crash lands between the temp write and the rename', async () => {
    const dir = join(root, 'crash');
    await new WorkflowLibrary(dir).save('crashy', flow('crashy'));
    const crashing = new WorkflowLibrary(dir, { rename: async () => { throw new Error('simulated crash'); } });
    await crashing.load();
    await expect(crashing.save('crashy', flow('crashy', '  - id: more\n    run: echo\n'))).rejects.toThrow('simulated crash');

    const reloaded = new WorkflowLibrary(dir);
    await reloaded.load();
    expect(reloaded.get('crashy').text).toBe(flow('crashy'));
    expect(reloaded.get('crashy').version).toBe(1);
    expect(await reloaded.listVersions('crashy')).toEqual([1]);
    expect(readdirSync(join(dir, 'workflows')).filter((f) => f.endsWith('.yaml'))).toEqual(['crashy.yaml']);
  });

  it('discards a version file orphaned by a process that died before its rename', async () => {
    const dir = join(root, 'orphan');
    await new WorkflowLibrary(dir).save('orphaned', flow('orphaned'));
    mkdirSync(join(dir, 'workflows', '.versions', 'orphaned'), { recursive: true });
    writeFileSync(join(dir, 'workflows', '.versions', 'orphaned', '2.yaml'), flow('orphaned', '  - id: lost\n    run: echo\n'));

    const reloaded = new WorkflowLibrary(dir);
    await reloaded.load();
    expect(reloaded.get('orphaned').version).toBe(1);
    expect((await reloaded.save('orphaned', flow('orphaned', '  - id: kept\n    run: echo\n'))).version).toBe(2);
  });

  it('keeps a Ticket-referenced version readable after two edits and prunes unreferenced ones', async () => {
    const dir = join(root, 'versions');
    const lib = new WorkflowLibrary(dir, { referencedVersions: async () => new Set(['pinned@1']) });
    await lib.save('pinned', flow('pinned'));
    await lib.save('pinned', flow('pinned', '  - id: two\n    run: echo 2\n'));
    await lib.save('pinned', flow('pinned', '  - id: three\n    run: echo 3\n'));

    expect((await lib.getVersion('pinned', 1)).text).toBe(flow('pinned'));
    expect(await lib.listVersions('pinned')).toEqual([1, 3]);
    await expect(lib.getVersion('pinned', 2)).rejects.toThrow(/no version 2/);

    const reloaded = new WorkflowLibrary(dir);
    await reloaded.load();
    expect(reloaded.get('pinned').version).toBe(3);
  });
});
