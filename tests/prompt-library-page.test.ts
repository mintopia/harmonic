// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../web/src/api.js';
import { PromptEditStep } from '../web/src/components/prompt-library/PromptEdit.js';
import { PromptFind } from '../web/src/components/prompt-library/PromptFind.js';
import { PromptsFlowProvider, promptsRailState, usePromptsFlow, type PromptsRailState } from '../web/src/components/prompt-library/PromptsFlow.js';
import type { Prompt, WorkflowLibraryEntry } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { assembleStepPrompt } from '../src/execution/prompt-assembly.js';
import { SAMPLE_DRIVE_FIELDS } from '../web/src/prompt-preview-model.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

function prompt(code: string, over: Partial<Prompt> = {}): Prompt {
  return { code, description: `${code} description`, text: `Body of ${code}`, bundled: false, category: 'prompt', resolved: `Body of ${code}`, usedBy: [], usedBySteps: [], updatedAt: null, ...over };
}

function workflow(name: string, tickets: number, running: number): WorkflowLibraryEntry {
  return { name, description: '', subject: 'ticket', version: 1, inUse: { tickets, running, workspaces: 1 }, assignedAs: [] };
}

const LIB: Prompt[] = [
  prompt('implement', { bundled: true, text: 'Implement ${{ ticket.title }}.' }),
  prompt('team-style', {
    text: 'Keep it small.\n${{ prompts.security-checklist }}',
    usedBy: ['release-notes'],
    usedBySteps: [
      { workflow: 'Default', stepId: 'implement', uses: 'agent' },
      { workflow: 'Security review', stepId: 'security', uses: 'critic' },
      { workflow: 'Default', stepId: 'review', uses: 'critic' },
    ],
    updatedAt: new Date(2026, 9, 29, 14, 2).toISOString(),
  }),
  prompt('security-checklist', { text: 'Check secrets.' }),
  prompt('release-notes', { text: 'Notes.\nUse ${{ prompts.team-style }}' }),
];

const WORKFLOWS = [workflow('Default', 5, 2), workflow('Security review', 3, 1), workflow('Unrelated', 9, 7)];

let rail: PromptsRailState | null = null;

function StepNav() {
  const flow = usePromptsFlow();
  useEffect(() => {
    rail = promptsRailState(flow);
  });
  return createElement(
    'nav',
    null,
    createElement('button', { type: 'button', onClick: () => flow.goStep('edit') }, 'To edit'),
    createElement('button', { type: 'button', onClick: () => flow.goStep('find') }, 'To find'),
  );
}

function Flow() {
  const [step, setStep] = useState('find');
  const body = step === 'edit' ? createElement(PromptEditStep) : createElement(PromptFind);
  return createElement(PromptsFlowProvider, { active: true, onStep: setStep }, createElement(StepNav), createElement('div', null, body));
}

async function mountLibrary(prompts = LIB, workflows = WORKFLOWS) {
  rail = null;
  vi.spyOn(api, 'prompts').mockResolvedValue({ prompts, total: prompts.length });
  vi.spyOn(api, 'workflows').mockResolvedValue({ workflows, total: workflows.length });
  vi.spyOn(api, 'assemblePrompt').mockImplementation(async (uses, text) => ({ segments: assembleStepPrompt(uses, text, bundledEnginePrompts()) }));
  return mountComponent(createElement(Flow));
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

function button(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  });
}

describe('Prompt Library page', () => {
  it('lists prompts with badges, used-by and the source strip', async () => {
    const host = await mountLibrary();
    expect(host.textContent).toContain('Bundled · 1');
    expect(host.textContent).toContain('Yours · 3');
    const row = host.querySelector('[data-prompt="team-style"]');
    expect(row?.textContent).toContain('Yours');
    expect(row?.textContent).toContain('3 steps · 1 prompt');
    expect(host.querySelector('[data-prompt="implement"]')?.textContent).toContain('Bundled');
    expect(host.querySelector('[data-prompt="implement"]')?.textContent).toContain('Unused');
  });

  it('shows the no-match empty state with Clear search', async () => {
    const host = await mountLibrary();
    await type(host.querySelector('input[type="search"]') as HTMLInputElement, 'secrity');
    expect(host.textContent).toContain('No prompts match “secrity”');
    await click(button(host, 'Clear search'));
    expect(host.querySelector('[data-prompt="implement"]')).not.toBeNull();
  });

  it('hides engine fragments from the list and search until Include engine fragments is on', async () => {
    const host = await mountLibrary([...LIB, prompt('criticRole', { bundled: true, category: 'fragment' })]);
    expect(host.querySelector('[data-prompt="criticRole"]')).toBeNull();
    await type(host.querySelector('input[type="search"]') as HTMLInputElement, 'critic');
    expect(host.textContent).toContain('No prompts match “critic”');
    await click([...host.querySelectorAll('label')].find((l) => l.textContent?.includes('Include engine fragments'))?.querySelector('input'));
    expect(host.querySelector('[data-prompt="criticRole"]')).not.toBeNull();
    await click(host.querySelector('[data-prompt="criticRole"] button'));
    await click(button(host, 'To find'));
    expect(host.querySelector('[data-prompt="criticRole"]')).not.toBeNull();
  });

  it('shows the no-own-prompts empty state when only bundled prompts exist', async () => {
    const host = await mountLibrary([prompt('implement', { bundled: true })]);
    expect(host.textContent).toContain('You have no prompts of your own yet');
  });

  it('lets a bundled entry be edited with no Duplicate or Delete', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="implement"] button'));
    const editor = host.querySelector('section[aria-label="Prompt implement"]') as HTMLElement;
    expect(editor).not.toBeNull();
    expect(button(editor, 'Duplicate')).toBeUndefined();
    expect(button(editor, 'Delete…')).toBeUndefined();
    expect(button(editor, 'Save')).toBeDefined();
    expect(editor.querySelector('textarea')).not.toBeNull();
    expect((editor.querySelector('#prompt-description') as HTMLInputElement).readOnly).toBe(false);
  });

  it('saves an edited bundled prompt as a new operator prompt, leaving the original unchanged', async () => {
    const host = await mountLibrary();
    const create = vi.spyOn(api, 'createPrompt').mockImplementation(async (body) => prompt(body.code, { ...body }));
    const update = vi.spyOn(api, 'updatePrompt');
    await click(host.querySelector('[data-prompt="implement"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'My own implement.');
    await click(button(host, 'Save'));
    expect(create).not.toHaveBeenCalled();
    const name = host.ownerDocument.querySelector('#prompt-fork-code') as HTMLInputElement;
    expect(name.value).toBe('implement-copy');

    await type(name, 'team-style');
    expect(host.ownerDocument.body.textContent).toContain('already exists');
    expect(button(host.ownerDocument.body, 'Save as new prompt')?.disabled).toBe(true);

    await type(name, 'my-implement');
    await click(button(host.ownerDocument.body, 'Save as new prompt'));
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ code: 'my-implement', description: 'implement description', text: 'My own implement.' });
    expect(host.querySelector('section[aria-label="Prompt my-implement"]')).not.toBeNull();

    await click(button(host, 'To find'));
    await click(host.querySelector('[data-prompt="implement"] button'));
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Implement ${{ ticket.title }}.');
    expect(rail?.summaries.edit).toBe('Change the text');
  });

  it('keeps the edit and the typed code when the server refuses a bundled save', async () => {
    const host = await mountLibrary();
    vi.spyOn(api, 'createPrompt').mockRejectedValue(new ApiError(400, 'Include cycle: my-implement → team-style → my-implement', 'validation'));
    await click(host.querySelector('[data-prompt="implement"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Use ${{ prompts.team-style }}');
    await click(button(host, 'Save'));
    await type(host.ownerDocument.querySelector('#prompt-fork-code') as HTMLInputElement, 'my-implement');
    await click(button(host.ownerDocument.body, 'Save as new prompt'));
    expect(host.ownerDocument.querySelector('#prompt-fork-code')).toBeNull();
    expect(host.textContent).toContain('Include cycle');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Use ${{ prompts.team-style }}');
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Fixed.');
    await click(button(host, 'Save'));
    expect((host.ownerDocument.querySelector('#prompt-fork-code') as HTMLInputElement).value).toBe('my-implement');
  });

  it('saves an operator prompt in place', async () => {
    const host = await mountLibrary();
    const update = vi.spyOn(api, 'updatePrompt').mockImplementation(async (code, body) => prompt(code, body));
    const create = vi.spyOn(api, 'createPrompt');
    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Check more secrets.');
    await click(button(host, 'Save'));
    expect(update).toHaveBeenCalledWith('security-checklist', { description: 'security-checklist description', text: 'Check more secrets.' });
    expect(create).not.toHaveBeenCalled();
  });

  it('shows an include cycle from a failed save inline and keeps Save disabled', async () => {
    const host = await mountLibrary();
    vi.spyOn(api, 'updatePrompt').mockRejectedValue(
      new ApiError(400, 'Include cycle: team-style → security-checklist → team-style', 'validation'),
    );
    await click(host.querySelector('[data-prompt="team-style"] button'));
    const text = host.querySelector('textarea') as HTMLTextAreaElement;
    await type(text, 'Keep it small.\n${{ prompts.security-checklist }}!');
    const save = button(host, 'Save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await click(save);
    const alert = host.querySelector('[data-issue="cycle"]');
    expect(alert?.textContent).toContain('Include cycle');
    expect(alert?.textContent).toContain('security-checklist');
    expect(alert?.textContent).toContain('Line 2');
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain('Fix the 1 error above');

    await type(text, 'Keep it small.');
    expect(host.querySelector('[data-issue="cycle"]')).toBeNull();
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('marks an unknown code with line, column and a usable suggestion', async () => {
    const host = await mountLibrary();
    vi.spyOn(api, 'updatePrompt').mockRejectedValue(new ApiError(400, 'Prompt includes unknown prompt code: secuirty-checklist', 'validation'));
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Hi\n${{ prompts.secuirty-checklist }}');
    await click(button(host, 'Save'));
    const alert = host.querySelector('[data-issue="unknown"]');
    expect(alert?.textContent).toContain('line 2, column 1');
    expect(alert?.textContent).toContain('Did you mean');
    await click(button(host, 'Use suggestion'));
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Hi\n${{ prompts.security-checklist }}');
    expect(host.querySelector('[data-issue]')).toBeNull();
  });

  it('blocks Save on a malformed reference without a round trip', async () => {
    const host = await mountLibrary();
    const update = vi.spyOn(api, 'updatePrompt');
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Finish in ${{ vars.report_format');
    expect(host.querySelector('[data-issue="malformed"]')?.textContent).toContain('never closed');
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it('shows Used by inline in the panel and opens an including prompt', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    expect(host.textContent).toContain('saved Oct 29 14:02');
    const usedBy = host.querySelector('section[aria-label="Prompt team-style"] article [data-testid="used-by"]') as HTMLElement;
    expect(usedBy.textContent).toMatch(/^Used by/);
    const rows = [...usedBy.querySelectorAll('[data-used-by]')];
    expect(rows.map((r) => r.getAttribute('data-used-by'))).toEqual(['step', 'step', 'step', 'prompt']);
    expect(rows[0]?.textContent).toBe('Default · implement');
    expect(rows[0]?.getAttribute('href')).toBe('/workflows');
    expect(rows[3]?.getAttribute('title')).toBe('Includes team-style on line 2');
    await click(rows[3]);
    expect(host.querySelector('section[aria-label="Prompt release-notes"]')).not.toBeNull();
  });

  it('draws the offending reference as a bad span in the text box', async () => {
    const host = await mountLibrary();
    vi.spyOn(api, 'updatePrompt').mockRejectedValue(new ApiError(400, 'Prompt includes unknown prompt code: secuirty-checklist', 'validation'));
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Hi\n${{ prompts.secuirty-checklist }}');
    expect(host.querySelector('[data-ref="include"]')?.textContent).toBe('${{ prompts.secuirty-checklist }}');
    await click(button(host, 'Save'));
    expect(host.querySelector('[data-ref="bad"]')?.textContent).toBe('${{ prompts.secuirty-checklist }}');
    expect(host.querySelector('[data-ref="include"]')).toBeNull();
  });

  it('renames after stating how many references it rewrites, refusing a taken code', async () => {
    const host = await mountLibrary();
    const ren = vi.spyOn(api, 'renamePrompt').mockResolvedValue(prompt('house-style'));
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await click(button(host, 'Rename…'));
    expect(host.textContent).toContain('4 references will be rewritten: 1 include in another prompt and 3 workflow steps.');
    const input = host.querySelector('input[aria-label="New code"]') as HTMLInputElement;
    await type(input, 'release-notes');
    expect(host.textContent).toContain('already exists');
    expect(button(host, 'Rename prompt')?.disabled).toBe(true);
    await type(input, 'house-style');
    await click(button(host, 'Rename prompt'));
    expect(ren).toHaveBeenCalledWith('team-style', 'house-style');
  });

  it('offers no Rename for a bundled prompt', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="implement"] button'));
    expect(button(host, 'Rename…')).toBeUndefined();
  });

  it('confirms before deleting and rejects a bad new code inline', async () => {
    const host = await mountLibrary();
    const del = vi.spyOn(api, 'deletePrompt').mockResolvedValue({ ok: true });
    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    await click(button(host, 'Delete…'));
    expect(del).not.toHaveBeenCalled();
    await click(button(host, 'Delete prompt'));
    expect(del).toHaveBeenCalledWith('security-checklist');

    await click(button(host, '+ New prompt'));
    await type(host.querySelector('#prompt-code') as HTMLInputElement, 'implement');
    expect(host.textContent).toContain('already exists (Bundled)');
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('filters with the All, Yours and Unused tabs and shows their counts', async () => {
    const host = await mountLibrary();
    const tabs = () => [...host.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs().map((t) => t.textContent)).toEqual(['All 4', 'Yours 3', 'Unused 3']);
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true');

    await click(tabs()[1]);
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect([...host.querySelectorAll('[data-prompt]')].map((r) => r.getAttribute('data-prompt'))).toEqual(['team-style', 'security-checklist', 'release-notes']);

    await click(tabs()[2]);
    expect([...host.querySelectorAll('[data-prompt]')].map((r) => r.getAttribute('data-prompt'))).toEqual(['implement', 'security-checklist', 'release-notes']);

    await click(tabs()[0]);
    expect(host.querySelectorAll('[data-prompt]')).toHaveLength(4);
  });

  it('moves to Edit when a code is clicked and keeps the draft when you come back', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    expect(host.querySelector('section[aria-label="Prompt security-checklist"]')).not.toBeNull();
    expect(host.querySelector('[data-prompt]')).toBeNull();

    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Check secrets and tokens.');
    await click(button(host, 'To find'));
    expect(host.querySelector('textarea')).toBeNull();

    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Check secrets and tokens.');
    expect(host.textContent).toContain('Edited');
  });

  it('sums running Tickets over the distinct workflows in the Used by line', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    expect(host.querySelector('[data-testid="running-now"]')?.textContent).toBe('3 Tickets running now');
  });

  it('uses the singular for one running Ticket and says when nothing uses the prompt', async () => {
    const host = await mountLibrary(LIB, [workflow('Default', 5, 0), workflow('Security review', 3, 1)]);
    await click(host.querySelector('[data-prompt="team-style"] button'));
    expect(host.querySelector('[data-testid="running-now"]')?.textContent).toBe('1 Ticket running now');

    await click(button(host, 'To find'));
    await click(host.querySelector('[data-prompt="release-notes"] button'));
    expect(host.querySelector('[data-testid="running-now"]')).toBeNull();
    expect(host.querySelector('[data-testid="used-by"]')?.textContent).toBe('Nothing uses this prompt yet.');
  });

  it('counts running Tickets reached through an include chain', async () => {
    const lib = LIB.map((p) => (p.code === 'security-checklist' ? { ...p, usedBy: ['team-style'] } : p));
    const host = await mountLibrary(lib);
    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    expect(host.querySelector('[data-testid="running-now"]')?.textContent).toBe('3 Tickets running now');
  });

  it('assembles one column: the editable prompt, then the engine guard and verdict contract as fixed blocks', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    const section = host.querySelector('section[aria-label="Prompt team-style"]') as HTMLElement;
    expect(section.querySelectorAll('article')).toHaveLength(1);
    expect(section.querySelector('article header [aria-label="Preview mode"]')).not.toBeNull();
    const sends = () => host.querySelector('[data-testid="step-sends"]') as HTMLElement;
    expect(sends().querySelector('[data-segment="operator"] textarea#prompt-text')).not.toBeNull();
    const select = host.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Default › implement · agent', 'Security review › security · critic', 'Default › review · critic']);
    expect(sends().querySelector('[data-segment="engine"]')).toBeNull();

    await act(async () => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
    const blocks = [...sends().querySelectorAll('[data-segment]')];
    expect(blocks.map((b) => b.getAttribute('data-segment'))).toEqual(['operator', 'engine', 'engine']);
    expect(blocks[0]?.textContent).toContain('Keep it small.');
    expect(blocks[1]?.textContent).toContain('Read-only critic guard');
    expect(blocks[1]?.textContent).toMatch(/READ-ONLY/i);
    expect(blocks[1]?.querySelector('textarea, input')).toBeNull();
    expect(blocks[2]?.textContent).toContain('Verdict contract');
    expect(api.assemblePrompt).toHaveBeenCalledWith('critic', '');
  });

  it('shows the assembled view for a bundled prompt', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="implement"] button'));
    expect((host.querySelector('[data-testid="step-sends"] textarea') as HTMLTextAreaElement).value).toContain('Implement');
  });

  it('switches the assembled view between the editable structure and the read-only filled preview', async () => {
    const lib = LIB.map((p) => (p.code === 'security-checklist' ? { ...p, text: 'Fix {title} for ${{ ticket.ref }}.' } : p));
    const host = await mountLibrary(lib);
    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    const operator = () => host.querySelector('[data-segment="operator"]') as HTMLElement;
    expect(operator().querySelector('[data-ref="context"]')?.textContent).toBe('${{ ticket.ref }}');

    await click(button(host, 'As sent'));
    expect(operator().querySelector('textarea, [data-ref]')).toBeNull();
    expect(operator().textContent).toContain(`Fix ${SAMPLE_DRIVE_FIELDS.title} for ${SAMPLE_DRIVE_FIELDS.ref}.`);

    await click(button(host, 'Structure'));
    expect((operator().querySelector('textarea') as HTMLTextAreaElement).value).toBe('Fix {title} for ${{ ticket.ref }}.');
  });

  it('fills unsaved edits and their includes into the As sent view', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="release-notes"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Only ${{ prompts.security-checklist }}');
    await click(button(host, 'As sent'));
    expect(host.querySelector('[data-segment="operator"]')?.textContent).toContain('Only Check secrets.');
  });

  it('keeps Save disabled for an unknown code and an include cycle until the text changes', async () => {
    const host = await mountLibrary();
    const update = vi.spyOn(api, 'updatePrompt');
    await click(host.querySelector('[data-prompt="security-checklist"] button'));

    update.mockRejectedValueOnce(new ApiError(400, 'Prompt includes unknown prompt code: team-stile', 'validation'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, '${{ prompts.team-stile }}');
    await click(button(host, 'Save'));
    expect(host.querySelector('[data-issue="unknown"]')).not.toBeNull();
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(true);

    update.mockRejectedValueOnce(new ApiError(400, 'Include cycle: security-checklist → team-style → security-checklist', 'validation'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, '${{ prompts.team-style }}');
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(false);
    await click(button(host, 'Save'));
    expect(host.querySelector('[data-issue="cycle"]')).not.toBeNull();
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('disables Edit in the rail until a prompt is picked', async () => {
    const host = await mountLibrary();
    expect([...(rail?.disabled ?? [])]).toEqual(['edit']);
    expect(rail?.summaries.edit).toBe('Pick a prompt first');
    expect(rail?.values.find).toBeUndefined();

    await click(host.querySelector('[data-prompt="team-style"] button'));
    expect(rail?.disabled.size).toBe(0);
    expect(rail?.values.find).toBe('team-style');
    expect(rail?.summaries.edit).toBe('Change the text');
  });

  it('summarises unsaved changes in the rail', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Different text.');
    expect(rail?.summaries.edit).toBe('1 unsaved change');
    await type(host.querySelector('#prompt-description') as HTMLInputElement, 'Changed');
    expect(rail?.summaries.edit).toBe('2 unsaved changes');
  });

  describe('included prompts', () => {
    const COMPOSED: Prompt[] = [
      prompt('drivePrompt', { bundled: true, text: 'Drive {ref}.', usedBy: ['implement-ticket', 'my-composite'] }),
      prompt('selfHeal', { bundled: true, text: 'Heal yourself.', usedBy: ['implement-ticket'] }),
      prompt('house', { text: 'House rules.', usedBy: ['my-composite'] }),
      prompt('implement-ticket', { bundled: true, text: '${{ prompts.drivePrompt }}{feedback}\n\n${{ prompts.selfHeal }}' }),
      prompt('my-composite', { text: '${{ prompts.drivePrompt }}\n${{ prompts.house }}' }),
    ];
    const region = (host: HTMLElement, code: string) => host.querySelector(`[data-included-prompt="${code}"]`) as HTMLDetailsElement;
    const regionText = (host: HTMLElement, code: string) => region(host, code).querySelector('textarea') as HTMLTextAreaElement;
    const source = (host: HTMLElement) => host.querySelector('#prompt-text') as HTMLTextAreaElement;

    it('renders each include as an expanded, editable region with its own Save, and the source collapsed', async () => {
      const host = await mountLibrary(COMPOSED);
      await click(host.querySelector('[data-prompt="implement-ticket"] button'));
      expect([...host.querySelectorAll('[data-included-prompt]')].map((e) => e.getAttribute('data-included-prompt'))).toEqual(['drivePrompt', 'selfHeal']);
      expect(region(host, 'drivePrompt').open).toBe(true);
      expect(regionText(host, 'drivePrompt').value).toBe('Drive {ref}.');
      expect(button(region(host, 'drivePrompt'), 'Save')?.disabled).toBe(true);
      const details = source(host).closest('details') as HTMLDetailsElement;
      expect(details.open).toBe(false);
      await type(source(host), '${{ prompts.selfHeal }}');
      expect([...host.querySelectorAll('[data-included-prompt]')].map((e) => e.getAttribute('data-included-prompt'))).toEqual(['selfHeal']);
    });

    it('forks a bundled include on save and repoints an operator parent at the copy', async () => {
      const host = await mountLibrary(COMPOSED);
      const create = vi.spyOn(api, 'createPrompt').mockImplementation(async (body) => prompt(body.code, body));
      const update = vi.spyOn(api, 'updatePrompt').mockImplementation(async (code, body) => prompt(code, body));
      await click(host.querySelector('[data-prompt="my-composite"] button'));
      await type(regionText(host, 'drivePrompt'), 'Drive {ref} carefully.');
      expect(region(host, 'drivePrompt').textContent).toContain('Edited');
      await click(button(region(host, 'drivePrompt'), 'Save'));
      const name = host.ownerDocument.querySelector('#prompt-fork-code') as HTMLInputElement;
      expect(name.value).toBe('drivePrompt-copy');
      await type(name, 'my-drive');
      await click(button(host.ownerDocument.body, 'Save as new prompt'));

      expect(create).toHaveBeenCalledWith({ code: 'my-drive', description: 'drivePrompt description', text: 'Drive {ref} carefully.' });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith('my-composite', { description: 'my-composite description', text: '${{ prompts.my-drive }}\n${{ prompts.house }}' });
      expect(source(host).value).toBe('${{ prompts.my-drive }}\n${{ prompts.house }}');
      expect(regionText(host, 'my-drive').value).toBe('Drive {ref} carefully.');
      expect(region(host, 'drivePrompt')).toBeNull();
      expect(rail?.summaries.edit).toBe('Change the text');
    });

    it('forks a bundled include in a bundled parent by repointing the parent draft, leaving both originals unsaved', async () => {
      const host = await mountLibrary(COMPOSED);
      vi.spyOn(api, 'createPrompt').mockImplementation(async (body) => prompt(body.code, body));
      const update = vi.spyOn(api, 'updatePrompt');
      await click(host.querySelector('[data-prompt="implement-ticket"] button'));
      await type(regionText(host, 'selfHeal'), 'Heal harder.');
      await click(button(region(host, 'selfHeal'), 'Save'));
      await click(button(host.ownerDocument.body, 'Save as new prompt'));
      expect(update).not.toHaveBeenCalled();
      expect(source(host).value).toBe('${{ prompts.drivePrompt }}{feedback}\n\n${{ prompts.selfHeal-copy }}');
      expect(rail?.summaries.edit).toBe('1 unsaved change');
    });

    it('keeps the copy and repoints the parent draft when storing the parent fails', async () => {
      const host = await mountLibrary(COMPOSED);
      vi.spyOn(api, 'createPrompt').mockImplementation(async (body) => prompt(body.code, body));
      vi.spyOn(api, 'updatePrompt').mockRejectedValue(new ApiError(500, 'disk full', 'internal'));
      await click(host.querySelector('[data-prompt="my-composite"] button'));
      await type(regionText(host, 'drivePrompt'), 'Drive carefully.');
      await click(button(region(host, 'drivePrompt'), 'Save'));
      await type(host.ownerDocument.querySelector('#prompt-fork-code') as HTMLInputElement, 'my-drive');
      await click(button(host.ownerDocument.body, 'Save as new prompt'));
      expect(source(host).value).toBe('${{ prompts.my-drive }}\n${{ prompts.house }}');
      expect(regionText(host, 'my-drive').value).toBe('Drive carefully.');
      expect(rail?.summaries.edit).toBe('1 unsaved change');
    });

    it('opens the collapsed source when it holds an error', async () => {
      const host = await mountLibrary(COMPOSED);
      await click(host.querySelector('[data-prompt="my-composite"] button'));
      await type(source(host), '${{ prompts.house }} ${{ prompts.nope');
      expect((source(host).closest('details') as HTMLDetailsElement).open).toBe(true);
    });

    it('saves an operator include in place without touching the parent', async () => {
      const host = await mountLibrary(COMPOSED);
      const create = vi.spyOn(api, 'createPrompt');
      const update = vi.spyOn(api, 'updatePrompt').mockImplementation(async (code, body) => prompt(code, body));
      await click(host.querySelector('[data-prompt="my-composite"] button'));
      await type(regionText(host, 'house'), 'Stricter house rules.');
      await click(button(region(host, 'house'), 'Save'));
      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith('house', { description: 'house description', text: 'Stricter house rules.' });
      expect(regionText(host, 'house').value).toBe('Stricter house rules.');
      expect(region(host, 'house').textContent).not.toContain('Edited');
    });
  });
});
