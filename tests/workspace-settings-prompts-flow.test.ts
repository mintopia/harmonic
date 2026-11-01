// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSettingsPage } from '../web/src/components/WorkspaceSettingsPage.js';
import { useOptionalPromptsFlow } from '../web/src/components/prompt-library/PromptsFlow.js';
import { cleanup, makeConfig, mountComponent } from './component-smoke-harness.js';

const apiMocks = vi.hoisted(() => ({ prompts: vi.fn() }));

vi.mock('../web/src/api.js', () => ({ api: apiMocks }));
vi.mock('../web/src/useSettingsLocation.js', () => ({
  useSettingsLocation: () => ({ tab: 'prompts', step: 'find', setTab: vi.fn(), setStep: vi.fn() }),
}));
vi.mock('../web/src/components/SettingsForm.js', () => ({
  SettingsForm: () => createElement('span', { 'data-testid': 'flow' }, useOptionalPromptsFlow() ? 'provided' : 'missing'),
}));

afterEach(cleanup);

describe('WorkspaceSettingsPage prompts tab', () => {
  it('provides the prompts flow and loads prompts', async () => {
    apiMocks.prompts.mockResolvedValue({ prompts: [] });
    const workspace = { id: 1, name: 'w' } as never;
    const { container } = await mountComponent(
      createElement(WorkspaceSettingsPage, { workspace, config: makeConfig(), blockedByRunningTask: false, onSaved: vi.fn(), onDeleted: vi.fn() }),
    );
    expect(container.querySelector('[data-testid="flow"]')?.textContent).toBe('provided');
    expect(apiMocks.prompts).toHaveBeenCalled();
  });
});
