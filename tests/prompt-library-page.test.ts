// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../web/src/api.js';
import { PromptLibrary } from '../web/src/components/prompt-library/PromptLibrary.js';
import type { Prompt } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

function prompt(code: string, over: Partial<Prompt> = {}): Prompt {
  return { code, description: `${code} description`, text: `Body of ${code}`, bundled: false, resolved: `Body of ${code}`, usedBy: [], ...over };
}

const LIB: Prompt[] = [
  prompt('implement', { bundled: true, text: 'Implement ${{ ticket.title }}.' }),
  prompt('team-style', { text: 'Keep it small.\n${{ prompts.security-checklist }}', usedBy: ['release-notes'] }),
  prompt('security-checklist', { text: 'Check secrets.' }),
  prompt('release-notes', { text: 'Notes.\nUse ${{ prompts.team-style }}' }),
];

async function mountLibrary(prompts = LIB) {
  vi.spyOn(api, 'prompts').mockResolvedValue({ prompts, total: prompts.length });
  return mountComponent(createElement(PromptLibrary));
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
  it('lists prompts with badges, used-by and the counts header', async () => {
    const host = await mountLibrary();
    expect(host.textContent).toContain('4 prompts · 1 Bundled · 3 yours');
    const row = host.querySelector('[data-prompt="team-style"]');
    expect(row?.textContent).toContain('Yours');
    expect(row?.textContent).toContain('1 prompt');
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
    expect(host.textContent).toContain('Includes team-style on line 2');
    await click(button(host, 'Open prompt'));
    expect(host.querySelector('section[aria-label="Prompt release-notes"]')).not.toBeNull();
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
});
