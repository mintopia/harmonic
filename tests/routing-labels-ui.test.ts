// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { Board } from '../web/src/components/Board.js';
import { RoutingLabelOverlayEditor } from '../web/src/components/RoutingLabelOverlayEditor.js';
import { RoutingLabelsEditor, firstRoutingLabelError, routingLabelErrors } from '../web/src/components/RoutingLabelsEditor.js';
import { Properties } from '../web/src/components/ticket/Metrics.js';
import type { AppConfig, RoutingLabelOverlayEntry, Task } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeTask, mountComponent } from './component-smoke-harness.js';

type Routes = AppConfig['routingLabels'];

const config = makeConfig({
  harnesses: {
    claude: { command: 'claude', args: [], env: {}, models: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-5-5' }], defaultModel: 'claude-sonnet-4-6', cacheWarmSeconds: 300 },
    codex: { command: 'codex', args: [], env: {}, models: [{ id: 'gpt-5-codex' }], defaultModel: 'gpt-5-codex', cacheWarmSeconds: 300 },
  },
});

let latest: Routes = [];
function capture(next: Routes) {
  latest = next;
}

function Harness({ initial }: { initial: Routes }) {
  const [items, setItems] = useState(initial);
  return createElement(RoutingLabelsEditor, { items, config, onChange: (next: Routes) => { capture(next); setItems(next); } });
}

const mountEditor = (initial: Routes) => mountComponent(createElement(Harness, { initial }));

async function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await flush();
  });
}

const click = async (el: Element | null) => {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
};

const byLabel = <T extends HTMLElement>(host: HTMLElement, label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;

beforeEach(() => {
  vi.spyOn(api, 'harnessProviders').mockResolvedValue({ providers: [] });
  vi.spyOn(api, 'harnessModels').mockResolvedValue({ models: [] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const two: Routes = [
  { label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' },
  { label: 'cheap', harness: 'codex', model: 'gpt-5-codex' },
];

describe('RoutingLabelsEditor', () => {
  it('shows the precedence hint and the add control', async () => {
    const host = await mountEditor([]);
    expect(host.textContent).toContain('Precedence');
    expect(host.textContent).toContain('Operator setting on the Ticket→Routing Label→Workspace default→Global default');
    expect(host.textContent).toContain('+ Add Routing Label');
  });

  it('adds a row seeded with the default Harness and its default Model', async () => {
    const host = await mountEditor([]);
    await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '+ Add Routing Label')!);
    expect(latest).toEqual([{ label: '', harness: 'claude', model: 'claude-sonnet-4-6' }]);
    expect(byLabel(host, 'Routing Label 1')).not.toBeNull();
  });

  it('edits a label and a model', async () => {
    const host = await mountEditor(two);
    await type(byLabel<HTMLInputElement>(host, 'Routing Label 2'), 'bulk');
    await type(byLabel<HTMLInputElement>(host, 'Model for Routing Label 2'), 'gpt-5-mini');
    expect(latest[1]).toEqual({ label: 'bulk', harness: 'codex', model: 'gpt-5-mini' });
  });

  it('removes a row and renumbers the rest', async () => {
    const host = await mountEditor(two);
    await click(byLabel(host, 'Remove Routing Label 1'));
    expect(latest.map((r) => r.label)).toEqual(['cheap']);
    expect(byLabel<HTMLInputElement>(host, 'Routing Label 1').value).toBe('cheap');
    expect(host.querySelector('[aria-label="Routing Label 2"]')).toBeNull();
  });

  it('resets the Model to the new Harness default when the Harness changes', async () => {
    const host = await mountEditor(two);
    await type(byLabel<HTMLSelectElement>(host, 'Harness for Routing Label 1'), 'codex');
    expect(latest[0]).toEqual({ label: 'reasoning', harness: 'codex', model: 'gpt-5-codex' });
    expect(byLabel<HTMLInputElement>(host, 'Model for Routing Label 1').value).toBe('gpt-5-codex');
  });

  it('reorders with the keyboard grip', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const row = this instanceof HTMLElement ? this.dataset.routingRow : undefined;
      return row === undefined ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, Number(row) * 60, 600, 50);
    });
    const host = await mountEditor(two);
    const grip = byLabel<HTMLButtonElement>(host, 'Reorder Routing Label 1');
    const key = async (target: EventTarget, code: string) => {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, bubbles: true }));
        await flush();
      });
    };
    grip.focus();
    await key(grip, 'Space');
    await key(document, 'ArrowDown');
    await key(document, 'Space');
    expect(latest.map((r) => r.label)).toEqual(['cheap', 'reasoning']);
  });

  it('rejects duplicate labels case-insensitively and blocks saving', async () => {
    const host = await mountEditor(two);
    await type(byLabel<HTMLInputElement>(host, 'Routing Label 2'), 'Reasoning');
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('already mapped');
    expect(byLabel(host, 'Routing Label 2').getAttribute('aria-invalid')).toBe('true');
    expect(firstRoutingLabelError(latest)).toContain('Routing Label 2');
  });

  it('flags an empty label', () => {
    expect(routingLabelErrors([{ label: '  ', harness: 'claude', model: 'm' }])).toEqual(['Enter a label.']);
    expect(firstRoutingLabelError(two)).toBeNull();
  });
});

type Overlay = RoutingLabelOverlayEntry[] | null;
let latestOverlay: Overlay = null;
function captureOverlay(next: RoutingLabelOverlayEntry[]) {
  latestOverlay = next;
}
const overlayConfig = { ...config, routingLabels: two };

function OverlayHarness({ initial }: { initial: Overlay }) {
  const [overlay, setOverlay] = useState<Overlay>(initial);
  return createElement(RoutingLabelOverlayEditor, {
    overlay,
    config: overlayConfig,
    onChange: (next: RoutingLabelOverlayEntry[]) => { captureOverlay(next); setOverlay(next); },
  });
}
const mountOverlay = (initial: Overlay) => mountComponent(createElement(OverlayHarness, { initial }));

describe('RoutingLabelOverlayEditor', () => {
  it('shows inherited globals locked with a Global chip and a switch, and no Remove', async () => {
    const host = await mountOverlay(null);
    expect(host.textContent).toContain('reasoning');
    expect(host.textContent).toContain('Global');
    expect(byLabel(host, 'Disable routing label 1').getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[aria-label="Remove Routing Label 1"]')).toBeNull();
    expect(host.querySelector('input[aria-label="Routing Label 1"]')).toBeNull();
  });

  it('disables a global row with the switch', async () => {
    const host = await mountOverlay(null);
    await click(byLabel(host, 'Disable routing label 2'));
    expect(latestOverlay).toEqual([
      { kind: 'global', ref: 'reasoning', enabled: true },
      { kind: 'global', ref: 'cheap', enabled: false },
    ]);
    expect(byLabel(host, 'Enable routing label 2').getAttribute('aria-checked')).toBe('false');
  });

  it('adds an editable local row and edits it', async () => {
    const host = await mountOverlay(null);
    await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '+ Add Routing Label')!);
    await type(byLabel<HTMLInputElement>(host, 'Routing Label 3'), 'security');
    expect(latestOverlay?.[2]).toEqual({ kind: 'local', enabled: true, routingLabel: { label: 'security', harness: 'claude', model: 'claude-sonnet-4-6' } });
    await click(byLabel(host, 'Remove Routing Label 3'));
    expect(latestOverlay).toHaveLength(2);
  });

  it('shows the duplicate error inline until the Global row is disabled', async () => {
    const host = await mountOverlay([{ kind: 'local', enabled: true, routingLabel: { label: 'Reasoning', harness: 'claude', model: 'claude-sonnet-4-6' } }]);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('duplicates the enabled Global label reasoning');
    expect(alert?.querySelector('code')?.textContent).toBe('reasoning');
    expect(byLabel(host, 'Routing Label 1').getAttribute('aria-invalid')).toBe('true');
    await click(byLabel(host, 'Disable routing label 2'));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('marks a dropped global as Removed and lets it be removed', async () => {
    const host = await mountOverlay([{ kind: 'global', ref: 'gone', enabled: true }]);
    expect(host.textContent).toContain('Removed');
    await click(byLabel(host, 'Remove Routing Label 1'));
    expect(latestOverlay?.some((e) => e.kind === 'global' && e.ref === 'gone')).toBe(false);
  });
});

const mountProps = (task: Task) => mountComponent(createElement(Properties, { task, allTasks: [task], workspaceName: 'ws' }));
const agentFact = (host: HTMLElement) => Array.from(host.querySelectorAll('dt')).find((dt) => dt.textContent === 'Agent')!.nextElementSibling!;

describe('Agent fact routing', () => {
  it('names the Routing Label that routed the Ticket', async () => {
    const host = await mountProps(makeTask({ routing: { label: 'reasoning', applied: true } }));
    const fact = agentFact(host);
    expect(fact.textContent?.replace(/\s+/g, ' ').trim()).toBe('Claude sonnet-4-6 — routed by reasoning');
    expect(fact.querySelector('code')?.textContent).toBe('reasoning');
  });

  it('explains that an operator setting won over the label', async () => {
    const host = await mountProps(makeTask({ routing: { label: 'reasoning', applied: false } }));
    const fact = agentFact(host);
    expect(fact.textContent?.replace(/\s+/g, ' ').trim()).toBe('Claude sonnet-4-6 — set on this Ticket · label reasoning not applied');
    expect(fact.querySelector('code')?.className).toContain('line-through');
  });

  it('adds nothing when no label matched', async () => {
    const host = await mountProps(makeTask({ routing: null }));
    expect(agentFact(host).textContent?.replace(/\s+/g, ' ').trim()).toBe('Claude sonnet-4-6');
  });
});

describe('Board card routing suffix', () => {
  const mountBoard = (tasks: Task[]) =>
    mountComponent(createElement(Board, { tasks, epics: [], loading: false, hasHistory: true, onOpen: () => {}, onOpenTask: () => {}, onNewTask: () => {} }));

  it('shows the ↳ label chip only when the label was applied', async () => {
    const host = await mountBoard([
      makeTask({ id: 1, state: 'working', routing: { label: 'reasoning', applied: true } }),
      makeTask({ id: 2, state: 'working', routing: { label: 'cheap', applied: false } }),
      makeTask({ id: 3, state: 'working', routing: null }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('↳ reasoning');
    expect(text).not.toContain('↳ cheap');
    expect(text.match(/↳ /g)).toHaveLength(1);
  });
});
