// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../web/src/api.js';
import { PromptEditStep } from '../web/src/components/prompt-library/PromptEdit.js';
import { PromptFind } from '../web/src/components/prompt-library/PromptFind.js';
import { PromptImpact } from '../web/src/components/prompt-library/PromptImpact.js';
import { PromptsFlowProvider, promptsRailState, usePromptsFlow, type PromptsRailState } from '../web/src/components/prompt-library/PromptsFlow.js';
import type { Prompt, WorkflowLibraryEntry } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

function prompt(code: string, over: Partial<Prompt> = {}): Prompt {
  return { code, description: `${code} description`, text: `Body of ${code}`, bundled: false, resolved: `Body of ${code}`, usedBy: [], usedBySteps: [], updatedAt: null, ...over };
}

function workflow(name: string, tickets: number, running: number): WorkflowLibraryEntry {
  return { name, description: '', subject: 'ticket', bundled: false, version: 1, inUse: { tickets, running, workspaces: 1 }, assignedAs: [] };
}

const LIB: Prompt[] = [
  prompt('implement', { bundled: true, text: 'Implement ${{ ticket.title }}.' }),
  prompt('team-style', {
    text: 'Keep it small.\n${{ prompts.security-checklist }}',
    usedBy: ['release-notes'],
    usedBySteps: [
      { workflow: 'Default', workflowBundled: true, stepId: 'implement' },
      { workflow: 'Security review', workflowBundled: false, stepId: 'security' },
      { workflow: 'Default', workflowBundled: true, stepId: 'review' },
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
    createElement('button', { type: 'button', onClick: () => flow.goStep('impact') }, 'To impact'),
    createElement('button', { type: 'button', onClick: () => flow.goStep('find') }, 'To find'),
  );
}

function Flow() {
  const [step, setStep] = useState('find');
  const body = step === 'edit' ? createElement(PromptEditStep) : step === 'impact' ? createElement(PromptImpact) : createElement(PromptFind);
  return createElement(PromptsFlowProvider, { active: true, onStep: setStep }, createElement(StepNav), createElement('div', null, body));
}

async function mountLibrary(prompts = LIB, workflows = WORKFLOWS) {
  rail = null;
  vi.spyOn(api, 'prompts').mockResolvedValue({ prompts, total: prompts.length });
  vi.spyOn(api, 'workflows').mockResolvedValue({ workflows, total: workflows.length });
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

  it('shows the no-own-prompts empty state when only bundled prompts exist', async () => {
    const host = await mountLibrary([prompt('implement', { bundled: true })]);
    expect(host.textContent).toContain('You have no prompts of your own yet');
  });

  it('renders a bundled entry read-only with Duplicate and no Save or Delete', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="implement"] button'));
    const editor = host.querySelector('section[aria-label="Prompt implement"]') as HTMLElement;
    expect(editor).not.toBeNull();
    expect(button(editor, 'Duplicate')).toBeDefined();
    expect(button(editor, 'Save')).toBeUndefined();
    expect(button(editor, 'Delete…')).toBeUndefined();
    expect(editor.querySelector('textarea')).toBeNull();
    expect((editor.querySelector('#prompt-description') as HTMLInputElement).readOnly).toBe(true);
    expect(editor.textContent).toContain('implement-copy');
  });

  it('duplicates a bundled entry as <code>-copy', async () => {
    const host = await mountLibrary();
    const dup = vi.spyOn(api, 'duplicatePrompt').mockResolvedValue(prompt('implement-copy'));
    await click(host.querySelector('[data-prompt="implement"] button'));
    await click(button(host, 'Duplicate'));
    expect(dup).toHaveBeenCalledWith('implement', 'implement-copy');
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

  it('previews nested includes and lists used-by prompts with the include line', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    const preview = host.querySelector('[data-testid="include-preview"]');
    expect(preview?.querySelector('[data-include="security-checklist"]')?.textContent).toContain('Check secrets.');
    await click(button(host, 'To impact'));
    expect(host.textContent).toContain('Includes team-style on line 2');
    await click(button(host, 'Open prompt'));
    expect(host.querySelector('section[aria-label="Prompt release-notes"]')).not.toBeNull();
  });

  it('lists workflow steps in Used by and shows when the prompt was edited', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    expect(host.textContent).toContain('saved Oct 29 14:02');
    await click(button(host, 'To impact'));
    const rows = [...host.querySelectorAll('[data-used-by]')];
    expect(rows.map((r) => r.getAttribute('data-used-by'))).toEqual(['step', 'step', 'step', 'prompt']);
    expect(rows[0]?.textContent).toContain('Default · step implement');
    expect(rows[0]?.textContent).toContain('Bundled workflow · 5 Tickets');
    expect(rows[1]?.textContent).toContain('Your workflow · 3 Tickets');
    expect(rows[0]?.querySelector('a')?.textContent).toBe('Open workflow');
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

  it('moves to Edit when a code is clicked and keeps the draft across Check impact', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    expect(host.querySelector('section[aria-label="Prompt security-checklist"]')).not.toBeNull();
    expect(host.querySelector('[data-prompt]')).toBeNull();

    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Check secrets and tokens.');
    await click(button(host, 'To impact'));
    expect(host.querySelector('section[aria-label="Impact of security-checklist"]')).not.toBeNull();
    expect(host.querySelector('textarea')).toBeNull();

    await click(button(host, 'To edit'));
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Check secrets and tokens.');
    expect(host.textContent).toContain('Edited');
  });

  it('sums running Tickets over the distinct workflows and lists Used by rows with Ticket counts', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await click(button(host, 'To impact'));
    expect(host.querySelector('[data-testid="running-now"]')?.textContent).toBe('3 Tickets running now');
    const rows = [...host.querySelectorAll('[data-used-by="step"]')];
    expect(rows[0]?.textContent).toContain('5 Tickets');
    expect(rows[1]?.textContent).toContain('3 Tickets');
  });

  it('uses the singular for one running Ticket and zero for an unused prompt', async () => {
    const host = await mountLibrary(LIB, [workflow('Default', 5, 0), workflow('Security review', 3, 1)]);
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await click(button(host, 'To impact'));
    expect(host.querySelector('[data-testid="running-now"]')?.textContent).toBe('1 Ticket running now');

    await click(button(host, 'To find'));
    await click(host.querySelector('[data-prompt="release-notes"] button'));
    await click(button(host, 'To impact'));
    expect(host.querySelector('[data-testid="running-now"]')?.textContent).toBe('0 Tickets running now');
    expect(host.textContent).toContain('Nothing uses this prompt yet.');
  });

  it('counts running Tickets reached through an include chain', async () => {
    const lib = LIB.map((p) => (p.code === 'security-checklist' ? { ...p, usedBy: ['team-style'] } : p));
    const host = await mountLibrary(lib);
    await click(host.querySelector('[data-prompt="security-checklist"] button'));
    await click(button(host, 'To impact'));
    expect(host.querySelector('[data-testid="running-now"]')?.textContent).toBe('3 Tickets running now');
  });

  it('updates the include preview as you type', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="release-notes"] button'));
    const preview = () => host.querySelector('[data-testid="include-preview"]') as HTMLElement;
    expect(preview().querySelector('[data-include="team-style"]')).not.toBeNull();
    expect(preview().querySelector('[data-include="security-checklist"]')).not.toBeNull();

    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Plain notes.');
    expect(preview().querySelector('[data-include]')).toBeNull();
    expect(preview().textContent).toContain('Plain notes.');

    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Only ${{ prompts.security-checklist }}');
    expect(preview().querySelector('[data-include="team-style"]')).toBeNull();
    expect(preview().querySelector('[data-include="security-checklist"]')?.textContent).toContain('Check secrets.');
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

  it('disables Edit and Check impact in the rail until a prompt is picked', async () => {
    const host = await mountLibrary();
    expect([...(rail?.disabled ?? [])].sort()).toEqual(['edit', 'impact']);
    expect(rail?.summaries.edit).toBe('Pick a prompt first');
    expect(rail?.summaries.impact).toBe('Pick a prompt first');
    expect(rail?.values.find).toBeUndefined();

    await click(host.querySelector('[data-prompt="team-style"] button'));
    expect(rail?.disabled.size).toBe(0);
    expect(rail?.values.find).toBe('team-style');
    expect(rail?.summaries.edit).toBe('Change the text');
    expect(rail?.summaries.impact).toBe('3 steps · 1 prompt');
  });

  it('summarises unsaved changes in the rail', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="team-style"] button'));
    await type(host.querySelector('textarea') as HTMLTextAreaElement, 'Different text.');
    expect(rail?.summaries.edit).toBe('1 unsaved change');
    await type(host.querySelector('#prompt-description') as HTMLInputElement, 'Changed');
    expect(rail?.summaries.edit).toBe('2 unsaved changes');
  });

  it('reports Read-only in the rail for a bundled prompt', async () => {
    const host = await mountLibrary();
    await click(host.querySelector('[data-prompt="implement"] button'));
    expect(rail?.summaries.edit).toBe('Read-only');
  });
});
