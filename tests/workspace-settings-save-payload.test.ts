// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSettingsPage } from '../web/src/components/WorkspaceSettingsPage.js';
import { SETTINGS_SCHEMA, renderSection, type GlobalRenderCtx, type WorkspaceRenderCtx } from '../web/src/components/settings-schema.js';
import { settingsRegistry, isOverridable, type SettingKey } from '../src/domain/settings-registry.js';
import { cleanup, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const apiMocks = vi.hoisted(() => ({ updateWorkspace: vi.fn() }));

vi.mock('../web/src/api.js', () => ({ api: apiMocks }));
vi.mock('../web/src/components/SettingsForm.js', () => ({
  SettingsForm: ({ onSave, ctx }: { onSave: () => void; ctx: WorkspaceRenderCtx; children?: ReactNode }) => {
    (globalThis as { __wsCtx?: WorkspaceRenderCtx }).__wsCtx = ctx;
    return createElement('button', { onClick: onSave }, 'Save');
  },
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.updateWorkspace.mockImplementation(async (_id: number, patch: object) => ({ ...makeWorkspace(), ...patch }));
});

const overridableKeys = (Object.keys(settingsRegistry) as SettingKey[]).filter(isOverridable);

describe('Workspace settings save payload', () => {
  it('sends every overridable field on Save, so no edit is silently dropped', async () => {
    const workspace = makeWorkspace();
    const host = await mountComponent(createElement(WorkspaceSettingsPage, {
      workspace, config: makeConfig(), blockedByRunningTask: false, onSaved: vi.fn(), onDeleted: vi.fn(),
    }));
    await act(async () => { host.querySelector('button')!.click(); });
    expect(apiMocks.updateWorkspace).toHaveBeenCalledTimes(1);
    const patch = apiMocks.updateWorkspace.mock.calls[0]![1] as Record<string, unknown>;
    const missing = [...overridableKeys, 'excludedDirectories'].filter((key) => !(key in patch));
    expect(missing).toEqual([]);
  });

  it('carries an edited resolver prompt through Save', async () => {
    const host = await mountComponent(createElement(WorkspaceSettingsPage, {
      workspace: makeWorkspace(), config: makeConfig(), blockedByRunningTask: false, onSaved: vi.fn(), onDeleted: vi.fn(),
    }));
    const ctx = (globalThis as { __wsCtx?: WorkspaceRenderCtx }).__wsCtx!;
    await act(async () => { ctx.setWorkspace({ ...ctx.workspace, mergeEpicRefreshPrompt: 'custom refresh', pauseMessage: 'hold on' }); });
    await act(async () => { host.querySelector('button')!.click(); });
    expect(apiMocks.updateWorkspace.mock.calls[0]![1]).toMatchObject({ mergeEpicRefreshPrompt: 'custom refresh', pauseMessage: 'hold on' });
  });

  it('labels each Workspace prompt the same as its global counterpart', async () => {
    const config = makeConfig();
    const workspace = makeWorkspace();
    const globalCtx: GlobalRenderCtx = {
      surface: 'global', config, baseline: config, setConfig: () => {}, errors: {}, harnessPermissionModes: {},
      channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
    };
    const workspaceCtx: WorkspaceRenderCtx = {
      surface: 'workspace', config, workspace, pristineWorkspace: workspace, setWorkspace: () => {}, errors: {},
      blockedByRunningTask: false, onRequestDelete: () => {},
    };
    const labelsBySuffix = async (ctx: GlobalRenderCtx | WorkspaceRenderCtx, prefix: string) => {
      const out = new Map<string, string>();
      for (const section of SETTINGS_SCHEMA.filter((s) => s.tab === 'prompts' && s.surfaces.includes(ctx.surface))) {
        const host = await mountComponent(createElement('div', null, renderSection(section, ctx).body));
        for (const label of host.querySelectorAll('label[for]')) {
          const id = label.getAttribute('for')!;
          if (id.startsWith(prefix)) out.set(id.slice(prefix.length), label.textContent!.trim());
        }
        await cleanup();
      }
      return out;
    };
    const global = await labelsBySuffix(globalCtx, 'settings-');
    const scoped = await labelsBySuffix(workspaceCtx, 'workspace-');
    expect(scoped.size).toBeGreaterThan(0);
    for (const [suffix, label] of scoped) {
      if (global.has(suffix)) expect({ suffix, label }).toEqual({ suffix, label: global.get(suffix) });
    }
  });
});
