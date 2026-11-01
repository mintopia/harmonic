// @vitest-environment jsdom
import { act, createElement } from 'react';
import { EditorView } from '@codemirror/view';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkflowsPage } from '../web/src/components/workflows/WorkflowsPage.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { registerErrorHandler } from '../src/server/app-hooks.js';
import { workflowRoutes } from '../src/server/routes/workflows.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const inBlock = (steps: string, max = 1): string => `  - attempts:\n      max: ${max}\n      steps:\n${steps.replace(/^(?=.)/gm, '      ')}`;
const FLOW = `name: flow-e2e\ndescription: imported\nsteps:\n${inBlock('  - id: build\n    run: npm test\n')}`;

describe('Workflows page: import, edit, save, export through the real routes and store', () => {
  let app: FastifyInstance;
  let dataDir: string;
  const get = async (path: string) => {
    const res = await app.inject({ method: 'GET', url: path });
    return { status: res.statusCode, body: res.json() };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-workflows-flow-'));
    const workflows = new WorkflowLibrary(dataDir);
    await workflows.load();
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app as never);
    await app.register(async (api) => workflowRoutes(api, { workflows, usage: async () => new Map(), assignments: async () => new Map() }), { prefix: '/api' });
    await app.ready();
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const res = await app.inject({ method: (init?.method ?? 'GET') as 'GET', url: input, headers: init?.headers as Record<string, string>, payload: init?.body as string });
      return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type'] ?? '') } });
    });
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  });
  afterEach(cleanup);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const click = async (el: Element | null | undefined) => {
    await act(async () => {
      (el as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 50));
      await flush();
    });
  };
  const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

  it('exports exactly the YAML that was saved', async () => {
    const downloads: Blob[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      downloads.push(blob as Blob);
      return 'blob:x';
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = () => {};

    const host = await mountComponent(createElement(WorkflowsPage));
    const picker = host.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [new File([FLOW], 'flow-e2e.yaml')], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await flush();
    });
    const row = [...host.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('flow-e2e'));
    expect(row).toBeDefined();

    await click(row!.querySelector('td button'));
    await act(async () => {
      [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'YAML')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
    expect(view.state.doc.toString()).toBe(FLOW);

    const edited = FLOW.replace('description: imported', 'description: edited in the browser');
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: edited } });
      await flush();
    });
    await click(button(host, 'Save as v2'));
    expect(host.textContent).toContain('v2');
    expect(host.textContent).toContain('Saved');

    await click(button(host, 'Export'));
    expect(downloads).toHaveLength(1);
    const exported = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(downloads[0]!);
    });
    expect(exported).toBe(edited);
    expect((await get('/api/workflows/flow-e2e')).body.text).toBe(edited);
  });

  it('refuses an invalid import without adding anything', async () => {
    const host = await mountComponent(createElement(WorkflowsPage));
    const picker = host.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [new File([FLOW.replace('run: npm test', 'run: npm test\n    retries: 1').replace('flow-e2e', 'flow-bad')], 'bad.yaml')], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await flush();
    });
    expect((await get('/api/workflows')).body.workflows.some((w: { name: string }) => w.name === 'flow-bad')).toBe(false);
  });
});
