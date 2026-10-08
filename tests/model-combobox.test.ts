// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelCombobox } from '../web/src/components/ModelCombobox.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

describe('ModelCombobox', () => {
  it('shows the friendly name when closed and keeps raw ids for other models', async () => {
    const claude = await mountComponent(
      createElement(ModelCombobox, { value: 'claude-opus-5-5', onChange: () => {}, options: ['claude-opus-5-5'], ariaLabel: 'Model' }),
    );
    expect(claude.querySelector<HTMLInputElement>('input')?.value).toBe('Opus 5.5');
    const codex = await mountComponent(
      createElement(ModelCombobox, { value: 'gpt-5-codex', onChange: () => {}, options: ['gpt-5-codex'], ariaLabel: 'Model' }),
    );
    expect(codex.querySelector<HTMLInputElement>('input')?.value).toBe('gpt-5-codex');
  });

  it('lists friendly names with raw ids and filters on either', async () => {
    const options = ['claude-opus-5-5', 'gpt-5-codex'];
    const open = async (value: string) => {
      const host = await mountComponent(createElement(ModelCombobox, { value, onChange: () => {}, options, ariaLabel: 'Model' }));
      await act(async () => {
        host.querySelector<HTMLInputElement>('input')!.focus();
      });
      return host;
    };
    const rows = (host: HTMLElement) => [...host.querySelectorAll('[role=option]')].map((r) => r.textContent);
    expect(rows(await open('')).at(0)).toBe('Opus 5.5claude-opus-5-5');
    expect(rows(await open('claude-o'))).toEqual(['Opus 5.5claude-opus-5-5']);
    expect(rows(await open('opus 5'))).toEqual(['Opus 5.5claude-opus-5-5']);
  });
});
