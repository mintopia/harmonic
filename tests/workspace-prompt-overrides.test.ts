// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverrideField } from '../web/src/components/settings-override-fields.js';
import { PROMPT_OVERRIDES, stepsForSurface } from '../web/src/components/settings-schema.js';
import { settingsRegistry } from '../src/domain/settings-registry.js';
import type { Workspace } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

vi.mock('../web/src/api.js', () => ({ api: {} }));

afterEach(cleanup);

let latest: Workspace = makeWorkspace();

function Harness({ onChange }: { onChange: (w: Workspace) => void }) {
  const [workspace, setWorkspaceState] = useState(makeWorkspace());
  const setWorkspace = (next: Workspace) => {
    onChange(next);
    setWorkspaceState(next);
  };
  const config = makeConfig({ pauseMessage: 'Global pause.' });
  return createElement(
    'div',
    null,
    PROMPT_OVERRIDES.map((descriptor) =>
      createElement(OverrideField, { key: descriptor.id, descriptor, config, workspace, errors: {}, onWorkspace: setWorkspace }),
    ),
  );
}

describe('Workspace prompt text overrides', () => {
  it('covers every overridable prompts-tab registry key and adds a rail step', () => {
    const keys = Object.entries(settingsRegistry)
      .filter(([, spec]) => spec.tab === 'prompts' && spec.scope === 'overridable')
      .map(([key]) => key)
      .sort();
    expect(PROMPT_OVERRIDES.map((d) => d.key).sort()).toEqual(keys);
    expect(stepsForSurface('workspace', 'prompts').map((s) => s.id)).toContain('overrides');
    expect(stepsForSurface('global', 'prompts').map((s) => s.id)).not.toContain('overrides');
  });

  it('renders one inheriting textarea per key, stores an edit, and reverts to null', async () => {
    const container = await mountComponent(createElement(Harness, { onChange: (w: Workspace) => { latest = w; } }));
    const areas = container.querySelectorAll('textarea');
    expect(areas).toHaveLength(3);
    const pause = container.querySelector<HTMLTextAreaElement>('#workspace-prompt-pauseMessage')!;
    expect(pause.value).toBe('Global pause.');
    expect(latest.pauseMessage).toBeNull();

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(pause, 'Custom pause.');
      pause.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    expect(latest.pauseMessage).toBe('Custom pause.');

    const revert = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Revert'))!;
    await act(async () => {
      revert.click();
      await flush();
    });
    expect(latest.pauseMessage).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('#workspace-prompt-pauseMessage')!.value).toBe('Global pause.');
  });
});
