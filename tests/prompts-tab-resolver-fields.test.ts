// @vitest-environment jsdom
import { Fragment, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

import { SETTINGS_SCHEMA, renderSection, type GlobalRenderCtx } from '../web/src/components/settings-schema.js';
import { cleanup, makeConfig, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(cleanup);

const config = makeConfig();
const ctx: GlobalRenderCtx = {
  surface: 'global',
  config,
  baseline: config,
  setConfig: () => {},
  errors: {},
  harnessPermissionModes: {},
  channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
};

async function mountPrompts() {
  const sections = SETTINGS_SCHEMA.filter((s) => s.tab === 'prompts' && s.surfaces.includes('global'));
  return mountComponent(createElement(Fragment, null, ...sections.map((s, i) => createElement(Fragment, { key: i }, renderSection(s, ctx).body))));
}

describe('Prompts tab resolver fields', () => {
  it('renders each new prompt as an editable textarea', async () => {
    const host = await mountPrompts();
    for (const id of [
      'settings-commit-nudge',
      'settings-fragment-conflict-resolution',
      'settings-merge-conflict-prompt',
      'settings-epic-conflict-prompt',
      'settings-epic-refresh-prompt',
      'settings-epic-resolve-suffix',
    ]) {
      expect(host.querySelector(`textarea#${id}`), id).not.toBeNull();
    }
  });

  it('lists the placeholders each prompt accepts', async () => {
    const host = await mountPrompts();
    const text = host.textContent ?? '';
    for (const token of ['{baseDir}', '{turn}', '{taskBranch}', '{baseBranch}', '{fragment.conflictResolution}', '{branch}']) {
      expect(text).toContain(token);
    }
  });
});
