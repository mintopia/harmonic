// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsForm } from '../web/src/components/SettingsForm.js';
import { cleanup, makeConfig, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

describe('settings layout (issue #554)', () => {
  it('gives verification the full desktop settings grid', async () => {
    const config = makeConfig();
    const host = await mountComponent(
      createElement(SettingsForm, {
        title: 'Settings',
        intro: 'Configure Harmonic.',
        tabs: [{ id: 'verification', label: 'Verification' }],
        tab: 'verification',
        onTab: () => {},
        ctx: {
          surface: 'global',
          config,
          baseline: config,
          setConfig: () => {},
          errors: {},
          channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
        },
        dirty: false,
        saving: false,
        error: null,
        onSave: () => {},
        onDiscard: () => {},
      }),
    );

    expect(host.querySelector('section')?.className).toContain('xl:col-span-2');
  });
});
