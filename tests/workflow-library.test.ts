import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tasks } from '../src/db/schema.js';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { parseWorkflow } from '../src/domain/workflow.js';
import { inBlock, startServer, type TestServer } from './helpers.js';

const flow = (name: string, extra = '') => `name: ${name}
description: A test flow
steps:
${inBlock('  - id: build\n    run: npm test\n')}${extra}`;

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
    const res = await server.api('PUT', '/api/workflows/broken', { text: 'name: broken\ndescription: x\nsteps:\n' + inBlock('  - id: build\n    run: npm test\n    bogus: 1\n') });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([expect.objectContaining({ line: 9, column: 11 })]);
    expect(existsSync(join(dataDir, 'workflows', 'broken.yaml'))).toBe(false);
    expect(existsSync(join(dataDir, 'workflows', '.versions', 'broken'))).toBe(false);
  });

  it('reports a YAML syntax error with its position', async () => {
    const res = await server.api('PUT', '/api/workflows/syntax', { text: 'name: syntax\nsteps: [\n' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].line).toBeGreaterThan(0);
  });

  describe('model option codes', () => {
    const optionFlow = (name: string, withLines: string, uses = 'agent') => `name: ${name}\ndescription: x\nsteps:\n${inBlock(`  - id: build\n    uses: ${uses}\n    with:\n${withLines}`)}`;
    const optionBase = async () => {
      const harnesses = (await server.api('GET', '/api/config')).body.harnesses as Record<string, { defaultModel: string }>;
      return { harness: 'claude', model: harnesses.claude!.defaultModel, description: 'd' };
    };
    const refused = async (name: string, text: string, line: number, column: number) => {
      const res = await server.api('PUT', `/api/workflows/${name}`, { text });
      expect(res.status).toBe(400);
      expect(res.body.error.issues).toEqual([expect.objectContaining({ line, column })]);
      expect(existsSync(join(dataDir, 'workflows', `${name}.yaml`))).toBe(false);
    };

    it('refuses a code that no list defines, pointing at the value, on save and import', async () => {
      const text = optionFlow('opt-unknown', '      option: nowhere\n');
      await refused('opt-unknown', text, 10, 21);
      const imported = await server.api('POST', '/api/workflows/import', { text });
      expect(imported.status).toBe(400);
      expect(imported.body.error.issues).toEqual([expect.objectContaining({ line: 10, column: 21 })]);
    });

    it('refuses a code disabled in every scope and accepts one enabled in a single scope', async () => {
      const ws = await server.api('POST', '/api/workspaces', { name: 'opt-ws', workingDir: root });
      expect(ws.status).toBe(201);
      const base = await optionBase();
      const patched = await server.api('PATCH', `/api/workspaces/${ws.body.id}`, { modelOptions: [{ kind: 'local', enabled: false, modelOption: { id: 'off-all', ...base } }, { kind: 'local', enabled: true, modelOption: { id: 'off-global', ...base } }] });
      expect(patched.status).toBe(200);
      await refused('opt-off', optionFlow('opt-off', '      option: off-all\n'), 10, 21);
      expect((await server.api('PUT', '/api/workflows/opt-one-scope', { text: optionFlow('opt-one-scope', '      option: off-global\n') })).status).toBe(200);
    });

    it('refuses option beside harness or model at the offending key, for agents and critics', async () => {
      const base = await optionBase();
      await server.api('PATCH', '/api/config', { modelOptions: [{ id: 'live', ...base }] });
      await refused('opt-h', optionFlow('opt-h', '      option: live\n      harness: claude\n'), 11, 13);
      await refused('opt-m', optionFlow('opt-m', '      option: live\n      model: stub-model\n'), 11, 13);
      await refused('opt-c', optionFlow('opt-c', '      option: live\n      prompt: p\n      model: stub-model\n', 'critic'), 12, 13);
      expect((await server.api('PUT', '/api/workflows/opt-critic', { text: optionFlow('opt-critic', '      option: live\n      prompt: p\n', 'critic') })).status).toBe(200);
      expect((await server.api('PUT', '/api/workflows/opt-nocritic', { text: optionFlow('opt-nocritic', '      prompt: p\n', 'critic') })).status).toBe(400);
    });
  });

  it('imports a file and exports the identical bytes', async () => {
    const text = `# my comment\n${flow('imported')}`;
    const imported = await server.api('POST', '/api/workflows/import', { text });
    expect(imported.status).toBe(201);
    const exported = await fetch(`${server.baseUrl}/api/workflows/imported/export`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
    expect(await exported.text()).toBe(text);
    expect(readFileSync(join(dataDir, 'workflows', 'imported.yaml'), 'utf8')).toBe(text);
  });

  it('lists the seeded workflows as editable and duplicates them', async () => {
    const seeded = await server.api('GET', '/api/workflows/implement');
    const saved = await server.api('PUT', '/api/workflows/implement', { text: seeded.body.text.replace('review: false', 'review: true') });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    expect(readFileSync(join(dataDir, 'workflows', 'implement.yaml'), 'utf8')).toContain('review: true');
    const copy = await server.api('POST', '/api/workflows/implement/duplicate', {});
    expect(copy.status).toBe(201);
    expect(copy.body.name).toBe('implement-copy');
  });

  it('refuses to delete a fallback workflow even with no default or ticket referencing it', async () => {
    for (const name of ['implement', 'research', 'epic']) {
      expect((await server.api('DELETE', `/api/workflows/${name}`)).status).toBe(409);
      expect(existsSync(join(dataDir, 'workflows', `${name}.yaml`))).toBe(true);
    }
  });

  it('lists inUse and assignedAs for every workflow', async () => {
    const list = await server.api('GET', '/api/workflows');
    const implement = list.body.workflows.find((w: { name: string }) => w.name === 'implement');
    expect(implement.inUse).toEqual({ tickets: 0, running: 0, workspaces: 0 });
    expect(implement.assignedAs).toEqual([]);
  });

  it('deletes an unused workflow with its file and versions, and 404s afterwards', async () => {
    await server.api('PUT', '/api/workflows/doomed', { text: flow('doomed') });
    await server.api('PUT', '/api/workflows/doomed', { text: flow('doomed', '  - id: more\n    run: echo\n') });
    expect(existsSync(join(dataDir, 'workflows', '.versions', 'doomed'))).toBe(true);
    expect((await server.api('DELETE', '/api/workflows/doomed')).status).toBe(204);
    expect(existsSync(join(dataDir, 'workflows', 'doomed.yaml'))).toBe(false);
    expect(existsSync(join(dataDir, 'workflows', '.versions', 'doomed'))).toBe(false);
    expect((await server.api('GET', '/api/workflows/doomed')).status).toBe(404);
    expect((await server.api('DELETE', '/api/workflows/doomed')).status).toBe(404);
  });

  it('counts a working ticket as running only under the workflow it is pinned to', async () => {
    await server.api('PUT', '/api/workflows/asked', { text: flow('asked') });
    await server.api('PUT', '/api/workflows/pinned', { text: flow('pinned') });
    const created = await server.api('POST', '/api/tasks', { prompt: 'p', workflow: 'asked' });
    await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ state: 'working', workflowRef: 'pinned@1' }).where(eq(tasks.id, created.body.id)).run());
    const list = await server.api('GET', '/api/workflows');
    const use = (name: string) => list.body.workflows.find((w: { name: string }) => w.name === name).inUse;
    expect(use('pinned')).toMatchObject({ tickets: 1, running: 1 });
    expect(use('asked')).toMatchObject({ tickets: 1, running: 0 });
  });

  it('refuses to delete a workflow a ticket references and counts the use', async () => {
    await server.api('PUT', '/api/workflows/busy', { text: flow('busy') });
    const created = await server.api('POST', '/api/tasks', { prompt: 'p', workflow: 'busy' });
    expect(created.status).toBe(201);
    const list = await server.api('GET', '/api/workflows');
    expect(list.body.workflows.find((w: { name: string }) => w.name === 'busy').inUse.tickets).toBe(1);
    expect((await server.api('DELETE', '/api/workflows/busy')).status).toBe(409);
    expect(existsSync(join(dataDir, 'workflows', 'busy.yaml'))).toBe(true);
  });
});

describe('WorkflowLibrary on a real filesystem', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-library-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('leaves the previous file intact when a crash lands between the temp write and the rename', async () => {
    const dir = join(root, 'crash');
    const seeder = new WorkflowLibrary(dir);
    await seeder.load();
    await seeder.save('crashy', flow('crashy'));
    const crashing = new WorkflowLibrary(dir, { rename: async () => { throw new Error('simulated crash'); } });
    await crashing.load();
    await expect(crashing.save('crashy', flow('crashy', '  - id: more\n    run: echo\n'))).rejects.toThrow('simulated crash');

    const reloaded = new WorkflowLibrary(dir);
    await reloaded.load();
    expect(reloaded.get('crashy').text).toBe(flow('crashy'));
    expect(reloaded.get('crashy').version).toBe(1);
    expect(await reloaded.listVersions('crashy')).toEqual([1]);
    expect(readdirSync(join(dir, 'workflows')).filter((f) => f.endsWith('.yaml')).sort()).toEqual(['crashy.yaml', 'epic.yaml', 'implement.yaml', 'research.yaml']);
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

  it('keeps a Ticket-pinned version on boot even when the current file was hand-edited', async () => {
    const dir = join(root, 'handedit');
    const lib = new WorkflowLibrary(dir, { referencedVersions: async () => new Set(['edited@1']) });
    await lib.save('edited', flow('edited'));
    await lib.save('edited', flow('edited', '  - id: two\n    run: echo\n'));
    writeFileSync(join(dir, 'workflows', 'edited.yaml'), flow('edited', '  - id: hand\n    run: echo\n'));

    const reloaded = new WorkflowLibrary(dir, { referencedVersions: async () => new Set(['edited@2']) });
    await reloaded.load();
    expect(await reloaded.listVersions('edited')).toEqual([1, 2]);
  });

  it('serialises concurrent saves so every version is kept in order', async () => {
    const lib = new WorkflowLibrary(join(root, 'concurrent'), { referencedVersions: async () => new Set(['race@1', 'race@2', 'race@3']) });
    const saved = await Promise.all([1, 2, 3].map((n) => lib.save('race', flow('race', `  - id: s${n}\n    run: echo\n`))));
    expect(saved.map((e) => e.version)).toEqual([1, 2, 3]);
    expect(await lib.listVersions('race')).toEqual([1, 2, 3]);
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

describe('agent step options', () => {
  const flow = (withBlock: string): string => `name: f\ndescription: d\nsteps:\n${inBlock(`  - id: build\n    uses: agent\n${withBlock}`)}`;

  it('accepts prompt, harness, model and continue options', () => {
    expect(() => parseWorkflow(flow('    with:\n      prompt: hi\n      harness: claude\n      model: m\n      continueAttempts: 2\n      continuePrompt: go on\n'))).not.toThrow();
  });

  it('accepts an agent step with no options', () => {
    expect(() => parseWorkflow(flow(''))).not.toThrow();
  });

  it('refuses an unknown key and a bad continueAttempts with a position', () => {
    expect(() => parseWorkflow(flow('    with:\n      colour: red\n'))).toThrow(/10:13 unknown key: colour/);
    expect(() => parseWorkflow(flow('    with:\n      continueAttempts: -1\n'))).toThrow(/with\.continueAttempts/);
  });
});

describe('critic steps and parallel groups', () => {
  const wf = (steps: string): string => `name: f\ndescription: d\nsteps:\n${steps}  - attempts:\n      max: 1\n      steps:\n        - id: tail\n          uses: verify\n`;
  const criticStep = (withBlock: string): string => `  - id: review\n    uses: critic\n${withBlock}`;

  it('accepts a critic with its own prompt, harness and model', () => {
    expect(() => parseWorkflow(wf(criticStep('    with:\n      prompt: hi\n      harness: claude\n      model: m\n')))).not.toThrow();
  });

  it('refuses a critic without an explicit Harness, Model or prompt, at the with block', () => {
    expect(() => parseWorkflow(wf(criticStep('    with:\n      prompt: hi\n      model: m\n')))).toThrow(/with\.harness: a critic needs its own harness/);
    expect(() => parseWorkflow(wf(criticStep('    with:\n      prompt: hi\n      harness: claude\n')))).toThrow(/with\.model: a critic needs its own model/);
    expect(() => parseWorkflow(wf(criticStep('')))).toThrow(/a critic needs its own prompt/);
  });

  it('accepts a parallel group of critics and refuses mutating or empty groups', () => {
    const critic = (id: string): string => `      - id: ${id}\n        uses: critic\n        with:\n          prompt: hi\n          harness: claude\n          model: m\n`;
    expect(() => parseWorkflow(wf(`  - id: panel\n    parallel:\n${critic('a')}${critic('b')}`))).not.toThrow();
    expect(() => parseWorkflow(wf(`  - id: panel\n    parallel:\n${critic('a')}      - id: m\n        uses: merge\n`))).toThrow(/merge cannot run inside parallel group panel/);
    expect(() => parseWorkflow(wf('  - id: panel\n    parallel: []\n'))).toThrow(/at least one step/);
    expect(() => parseWorkflow(wf(`  - id: panel\n    parallel:\n${critic('a')}${critic('a')}`))).toThrow(/duplicate step id: a/);
  });
});

describe('stored workflows saved before the stricter with: rules', () => {
  const legacy = `name: legacy\ndescription: old\nsteps:\n${inBlock('  - id: ship\n    uses: merge\n    with:\n      mode: squash\n')}`;

  it('still load and parse leniently, while a new save is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-legacy-'));
    try {
      mkdirSync(join(root, 'workflows', '.versions', 'legacy'), { recursive: true });
      writeFileSync(join(root, 'workflows', 'legacy.yaml'), legacy);
      writeFileSync(join(root, 'workflows', '.versions', 'legacy', '1.yaml'), legacy);
      const library = new WorkflowLibrary(root);
      await library.load();
      expect(library.list().map((e) => e.name)).toContain('legacy');
      expect(() => parseWorkflow(legacy, { lenient: true })).not.toThrow();
      expect(() => parseWorkflow(legacy)).toThrow(/unknown key: mode/);
      await expect(library.save('legacy', legacy)).rejects.toThrow(/unknown key: mode/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('seeding the packaged workflows on boot', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-seed-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const onDisk = (dir: string) => Object.fromEntries(['implement', 'research', 'epic'].map((n) => [n, readFileSync(join(dir, 'workflows', `${n}.yaml`), 'utf8')]));

  it('writes version 1 of each once, and a second boot changes nothing', async () => {
    const dir = join(root, 'fresh');
    const first = new WorkflowLibrary(dir);
    await first.load();
    expect(first.list().map((e) => e.name)).toEqual(['epic', 'implement', 'research']);
    const seeded = onDisk(dir);
    for (const n of Object.keys(seeded)) {
      expect(parseWorkflow(seeded[n]!).name).toBe(n);
      expect(readFileSync(join(dir, 'workflows', '.versions', n, '1.yaml'), 'utf8')).toBe(seeded[n]);
    }
    await first.save('implement', seeded.implement!.replace('review: false', 'review: true'));
    const edited = onDisk(dir);
    const second = new WorkflowLibrary(dir);
    await second.load();
    expect(onDisk(dir)).toEqual(edited);
    expect(second.get('implement').version).toBe(2);
    expect(readdirSync(join(dir, 'workflows')).filter((f) => f.endsWith('.yaml')).sort()).toEqual(['epic.yaml', 'implement.yaml', 'research.yaml']);
  });

  it('never overwrites an existing operator file of that name', async () => {
    const dir = join(root, 'existing');
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    const mine = flow('research');
    writeFileSync(join(dir, 'workflows', 'research.yaml'), mine);
    const library = new WorkflowLibrary(dir);
    await library.load();
    expect(readFileSync(join(dir, 'workflows', 'research.yaml'), 'utf8')).toBe(mine);
    expect(library.list().map((e) => e.name)).toEqual(['epic', 'implement', 'research']);
  });
});
