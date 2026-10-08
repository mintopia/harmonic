// @vitest-environment jsdom
import { createElement } from 'react';
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
});
