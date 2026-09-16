import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { HarnessesSection } from '../web/src/components/HarnessSettings.js';

const permissionModes = {
  claude: { modes: { auto: 'Auto', bypassPermissions: 'Bypass Permissions' }, defaultMode: 'auto' },
  copilot: { modes: { auto: 'Auto', bypassPermissions: 'Bypass Permissions' }, defaultMode: 'auto' },
};

describe('Harness settings permission mode', () => {
  it('shows adapter-labelled modes only for configurable Harnesses', () => {
    const config = baselineConfig();
    const html = renderToStaticMarkup(
      createElement(HarnessesSection, {
        config,
        baseline: baselineConfig(),
        fieldErrors: {},
        permissionModes,
        onChange: () => {},
      }),
    );

    expect(html).toMatch(/id="harness-claude-permission-mode"[^>]*><option value="auto" selected="">Auto<\/option>/);
    expect(html).toContain('id="harness-copilot-permission-mode"');
    expect(html).toContain('>Auto</option>');
    expect(html).toContain('>Bypass Permissions</option>');
    expect(html).not.toContain('id="harness-codex-permission-mode"');
    expect(html).not.toContain('id="harness-opencode-permission-mode"');
  });

  it('renders the persisted mode as selected', () => {
    const config = baselineConfig();
    config.harnesses.claude.permissionMode = 'bypassPermissions';
    const html = renderToStaticMarkup(
      createElement(HarnessesSection, {
        config,
        baseline: baselineConfig(),
        fieldErrors: {},
        permissionModes,
        onChange: () => {},
      }),
    );

    expect(html).toMatch(/id="harness-claude-permission-mode"[^>]*><option value="auto">Auto<\/option><option value="bypassPermissions" selected="">Bypass Permissions<\/option>/);
  });
});
