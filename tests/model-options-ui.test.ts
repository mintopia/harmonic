// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { ModelOptionsEditor } from '../web/src/components/ModelOptionsEditor.js';
import { RouteClassifierSettings } from '../web/src/components/RouteClassifierSettings.js';
import { firstModelOptionError } from '../web/src/components/model-option-model.js';
import type { ModelOption, Workspace } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

const config = makeConfig({
  harnesses: {
    claude: { command: 'claude', args: [], env: {}, models: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-5-5' }], defaultModel: 'claude-sonnet-4-6', cacheWarmSeconds: 300 },
    codex: { command: 'codex', args: [], env: {}, models: [{ id: 'gpt-5-codex' }], defaultModel: 'gpt-5-codex', cacheWarmSeconds: 300 },
  },
});

const small: ModelOption = { id: 'sonnet-small', harness: 'claude', model: 'claude-sonnet-4-6', description: 'Small fixes' };
const deep: ModelOption = { id: 'opus-deep', harness: 'claude', model: 'claude-opus-5-5', description: 'Hard refactors' };

let latest: ModelOption[] = [];
const capture = (next: ModelOption[]) => {
  latest = next;
};

function Harness({ initial, globals, errors }: { initial: ModelOption[]; globals?: ModelOption[]; errors?: Record<string, string> }) {
  const [items, setItems] = useState(initial);
  return createElement(ModelOptionsEditor, {
    items,
    globals,
    workspace: globals !== undefined,
    config,
    errors: errors ?? {},
    onChange: (next: ModelOption[]) => {
      capture(next);
      setItems(next);
    },
  });
}

const mount = (initial: ModelOption[], globals?: ModelOption[], errors?: Record<string, string>) =>
  mountComponent(createElement(Harness, { initial, globals, errors }));

async function type(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
const byId = <T extends HTMLElement>(host: HTMLElement, id: string) => host.querySelector<T>(`#${id}`)!;
const button = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text)!;

beforeEach(() => {
  vi.spyOn(api, 'harnessProviders').mockResolvedValue({ providers: [] });
  vi.spyOn(api, 'harnessModels').mockResolvedValue({ models: [] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('ModelOptionsEditor (global)', () => {
  it('shows the Route Classifier precedence step, the add link and the empty state', async () => {
    const host = await mount([]);
    expect(host.textContent).toContain('Operator setting on the Ticket→Routing Label→Route Classifier→Workspace default→Global default');
    expect(host.textContent).toContain('+ Add Model Option');
    expect(host.textContent).toContain('No Model Options yet');
    expect(host.textContent).toContain('Epics are not classified, and Critics are never classified');
  });

  it('adds a Model Option through the form, seeded with the default Harness and Model', async () => {
    const host = await mount([]);
    await click(button(host, '+ Add Model Option'));
    expect(byId<HTMLSelectElement>(host, 'model-option-harness').value).toBe('claude');
    expect(byLabel<HTMLInputElement>(host, 'Model').value).toBe('Sonnet 4.6');
    await type(byId<HTMLInputElement>(host, 'model-option-code'), 'cheap-fix');
    await type(byId<HTMLTextAreaElement>(host, 'model-option-description'), 'Tiny fixes');
    await click(button(host, 'Save Model Option'));
    expect(latest).toEqual([{ id: 'cheap-fix', harness: 'claude', model: 'claude-sonnet-4-6', description: 'Tiny fixes' }]);
    expect(host.textContent).toContain('cheap-fix');
    expect(host.querySelector('#model-option-code')).toBeNull();
  });

  it('refuses a bad or duplicate code and a blank description inline, saving nothing', async () => {
    latest = [];
    const host = await mount([small]);
    await click(button(host, '+ Add Model Option'));
    await type(byId<HTMLInputElement>(host, 'model-option-code'), 'Bad Code');
    await click(button(host, 'Save Model Option'));
    expect(host.textContent).toContain('lowercase letters, digits and hyphens');
    await type(byId<HTMLInputElement>(host, 'model-option-code'), 'sonnet-small');
    await click(button(host, 'Save Model Option'));
    expect(host.textContent).toContain("Code 'sonnet-small' is already used by Model Option 1. Codes must be unique.");
    expect(host.textContent).toContain('Describe when it fits');
    expect(byId(host, 'model-option-code').getAttribute('aria-invalid')).toBe('true');
    expect(latest).toEqual([]);
  });

  it('resets the Model to the new Harness default and says so', async () => {
    const host = await mount([small]);
    await click(byLabel(host, 'Edit Model Option 1'));
    await type(byId<HTMLSelectElement>(host, 'model-option-harness'), 'codex');
    expect(byLabel<HTMLInputElement>(host, 'Model').value).toBe('gpt-5-codex');
    expect(host.textContent).toContain('Model reset to Codex default gpt-5-codex');
  });

  it('refuses a Model outside the Harness catalog', async () => {
    const host = await mount([small]);
    await click(byLabel(host, 'Edit Model Option 1'));
    await type(byLabel<HTMLInputElement>(host, 'Model'), 'gpt-9');
    await click(button(host, 'Save Model Option'));
    expect(host.textContent).toContain("Model 'gpt-9' is not in the claude model catalog");
  });

  it('edits a row in place and cancel discards the draft', async () => {
    const host = await mount([small, deep]);
    await click(byLabel(host, 'Edit Model Option 2'));
    await type(byId<HTMLTextAreaElement>(host, 'model-option-description'), 'Anything hard');
    await click(button(host, 'Cancel'));
    expect(host.textContent).toContain('Hard refactors');
    await click(byLabel(host, 'Edit Model Option 2'));
    await type(byId<HTMLTextAreaElement>(host, 'model-option-description'), 'Anything hard');
    await click(button(host, 'Save Model Option'));
    expect(latest).toEqual([small, { ...deep, description: 'Anything hard' }]);
  });

  it('removes a row and renumbers the rest', async () => {
    const host = await mount([small, deep]);
    await click(byLabel(host, 'Remove Model Option 1'));
    expect(latest).toEqual([deep]);
    expect(byLabel(host, 'Edit Model Option 1')).not.toBeNull();
    expect(host.querySelector('[aria-label="Edit Model Option 2"]')).toBeNull();
  });

  it('reorders with the keyboard grip', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const row = this instanceof HTMLElement ? this.dataset.routingRow : undefined;
      return row === undefined ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, Number(row) * 60, 600, 50);
    });
    const host = await mount([small, deep]);
    const grip = byLabel<HTMLButtonElement>(host, 'Reorder Model Option 1');
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
    expect(latest.map((o) => o.id)).toEqual(['opus-deep', 'sonnet-small']);
  });

  it('shows API refusals inline against the offending row', async () => {
    const host = await mount([small, deep], undefined, {
      'modelOptions.1.harness': "Harness 'opencode' is not configured.",
      'modelOptions.0.model': "model option 'sonnet-small' model 'gpt-9' is not in the claude harness's model list",
    });
    const rows = host.querySelectorAll('[data-routing-row]');
    expect(rows[0]?.textContent).toContain("model 'gpt-9' is not in the claude harness's model list");
    expect(rows[1]?.textContent).toContain("Harness 'opencode' is not configured.");
    expect(rows[0]?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows an API refusal on the field of the open edit form', async () => {
    const host = await mount([small], undefined, { 'modelOptions.0.id': "model option id 'sonnet-small' is already used" });
    await click(byLabel(host, 'Edit Model Option 1'));
    expect(host.textContent).toContain("model option id 'sonnet-small' is already used");
  });
});

describe('ModelOptionsEditor (Workspace overlay)', () => {
  it('renders inherited Global rows locked and local rows editable with a Workspace chip', async () => {
    const host = await mount([deep], [small]);
    const rows = Array.from(host.querySelectorAll('[data-routing-row]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('sonnet-small');
    expect(rows[0]?.textContent).toContain('Global');
    expect(rows[0]?.querySelector('[aria-label^="Edit"]')).toBeNull();
    expect(rows[0]?.querySelector('[aria-label^="Remove"]')).toBeNull();
    expect(rows[1]?.textContent).toContain('opus-deep');
    expect(rows[1]?.textContent).toContain('Workspace');
    expect(byLabel(host, 'Edit Model Option 2')).not.toBeNull();
  });

  it('refuses a code already used by a Global row and numbers it by resolved position', async () => {
    const host = await mount([], [small]);
    await click(button(host, '+ Add Model Option'));
    await type(byId<HTMLInputElement>(host, 'model-option-code'), 'sonnet-small');
    await type(byId<HTMLTextAreaElement>(host, 'model-option-description'), 'x');
    await click(button(host, 'Save Model Option'));
    expect(host.textContent).toContain("Code 'sonnet-small' is already used by Model Option 1");
  });

  it('keeps Global rows ahead of local rows when adding', async () => {
    const host = await mount([], [small]);
    await click(button(host, '+ Add Model Option'));
    await type(byId<HTMLInputElement>(host, 'model-option-code'), 'opus-deep');
    await type(byId<HTMLTextAreaElement>(host, 'model-option-description'), 'Hard');
    await click(button(host, 'Save Model Option'));
    expect(latest.map((o) => o.id)).toEqual(['opus-deep']);
    expect(byLabel(host, 'Edit Model Option 2')).not.toBeNull();
  });
});

describe('firstModelOptionError', () => {
  it('flags malformed and repeated codes, counting Global rows first', () => {
    expect(firstModelOptionError([small, deep])).toBeNull();
    expect(firstModelOptionError([small, { ...deep, id: 'sonnet-small' }])).toContain('Model Option 2');
    expect(firstModelOptionError([{ ...deep, id: 'Bad' }])).toContain('Model Option 1');
    expect(firstModelOptionError([deep], ['opus-deep'])).toContain('Model Option 2');
  });
});

describe('RouteClassifierSettings', () => {
  let latestWs: Workspace;
  const captureWs = (next: Workspace) => {
    latestWs = next;
  };
  function Classifier({ initial, optionCount = 1, errors = {} }: { initial: Workspace; optionCount?: number; errors?: Record<string, string> }) {
    const [ws, setWs] = useState(initial);
    return createElement(RouteClassifierSettings, {
      workspace: ws,
      optionCount,
      errors,
      onChange: (next: Workspace) => {
        captureWs(next);
        setWs(next);
      },
    });
  }
  const mountClassifier = (initial: Partial<Workspace> = {}, optionCount = 1, errors: Record<string, string> = {}) =>
    mountComponent(createElement(Classifier, { initial: makeWorkspace(initial), optionCount, errors }));
  const radio = (host: HTMLElement, name: string) => Array.from(host.querySelectorAll('[role="radio"]')).find((b) => b.textContent === name)!;

  beforeEach(() => {
    vi.spyOn(api, 'secretStatus').mockResolvedValue({ name: 'KEY', set: false });
  });

  it('is off by default, with the controls disabled; the switch turns it on', async () => {
    const host = await mountClassifier();
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    await click(byLabel(host, 'Route Classifier'));
    expect(latestWs.classifierEnabled).toBe(true);
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
  });

  it('defaults to the Harness backend with no Secret field and a 30 s timeout placeholder', async () => {
    const host = await mountClassifier({ classifierEnabled: true });
    expect(radio(host, 'Harness').getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('#classifier-secret')).toBeNull();
    expect(byId<HTMLInputElement>(host, 'classifier-timeout').placeholder).toBe('30');
  });

  it('switching backend swaps the fields: Secret for TypeSafe, Endpoint URL and Secret for OpenAI-compatible', async () => {
    const host = await mountClassifier({ classifierEnabled: true });
    await click(radio(host, 'TypeSafe decision model'));
    expect(latestWs.classifierBackend).toBe('typesafe');
    await type(byId<HTMLInputElement>(host, 'classifier-secret'), 'OPENROUTER_API_KEY');
    expect(latestWs.classifierTypesafeSecret).toBe('OPENROUTER_API_KEY');
    await click(radio(host, 'OpenAI-compatible endpoint'));
    await type(byId<HTMLInputElement>(host, 'classifier-endpoint-url'), 'https://llm.internal/v1');
    await type(byId<HTMLInputElement>(host, 'classifier-endpoint-model'), 'gpt-5-mini');
    await type(byId<HTMLInputElement>(host, 'classifier-secret'), 'CLASSIFIER_ENDPOINT_KEY');
    expect(latestWs.classifierEndpoint).toEqual({ baseUrl: 'https://llm.internal/v1', model: 'gpt-5-mini', apiKeySecret: 'CLASSIFIER_ENDPOINT_KEY' });
  });

  it('warns when the named Secret is not set, and sets timeout or clears it back to inherit', async () => {
    const host = await mountClassifier({ classifierEnabled: true, classifierBackend: 'typesafe', classifierTypesafeSecret: 'KEY' });
    await act(async () => {
      await flush();
    });
    expect(host.textContent).toContain('Secret not set');
    await type(byId<HTMLInputElement>(host, 'classifier-timeout'), '45');
    expect(latestWs.classifierTimeoutSeconds).toBe(45);
    await type(byId<HTMLInputElement>(host, 'classifier-timeout'), '');
    expect(latestWs.classifierTimeoutSeconds).toBeNull();
  });

  it('warns when the classifier is on with no Model Options', async () => {
    const host = await mountClassifier({ classifierEnabled: true }, 0);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('No Model Options.');
    await cleanup();
    const quiet = await mountClassifier({ classifierEnabled: true }, 2);
    expect(quiet.querySelector('[role="status"]')).toBeNull();
  });

  it('shows API refusals at the field', async () => {
    const host = await mountClassifier({ classifierEnabled: true, classifierBackend: 'openai-compatible' }, 1, {
      'classifierEndpoint.baseUrl': 'Invalid URL',
      classifierTimeoutSeconds: 'Must be at least 1',
    });
    expect(host.textContent).toContain('Invalid URL');
    expect(host.textContent).toContain('Must be at least 1');
  });
});
