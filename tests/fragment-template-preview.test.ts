// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, renderSection, type GlobalRenderCtx, type WorkspaceRenderCtx } from '../web/src/components/settings-schema.js';
import { FRAGMENT_TEMPLATE_FIELDS, promptFragmentOverrideKey } from '../src/domain/prompt-fragments.js';
import { compileCriticPreview } from '../web/src/prompt-preview-model.js';
import { buildCriticPrompt } from '../src/verification/critic-prompt.js';
import { cleanup, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const FRAGMENT = 'conflictResolution';
const marker = (scope: string, name: string) => `${scope}:${name}<{fragment.${FRAGMENT}}>`;
const expanded = (scope: string, name: string, text: string) => `${scope}:${name}<${text}>`;

const globalTemplates: Record<string, string> = {
  taskPrompt: 'taskPrompt',
  'drive.prompt': 'drivePrompt',
  'drive.unattendedReminder': 'driveUnattendedReminder',
  'drive.continuePrompt': 'driveContinuePrompt',
  'drive.commitNudge': 'driveCommitNudge',
  pauseMessage: 'pauseMessage',
  'merge.conflictPrompt': 'mergeConflictPrompt',
  'merge.epicConflictPrompt': 'mergeEpicConflictPrompt',
  'merge.epicRefreshPrompt': 'mergeEpicRefreshPrompt',
  'verify.epic.resolveSuffix': 'verifyEpicResolveSuffix',
};

const previewText = async (ctx: GlobalRenderCtx | WorkspaceRenderCtx) => {
  let text = '';
  for (const section of SETTINGS_SCHEMA.filter((s) => s.tab === 'prompts' && s.surfaces.includes(ctx.surface))) {
    const host = await mountComponent(createElement('div', null, renderSection(section, ctx).body));
    text += host.textContent;
    await cleanup();
  }
  return text;
};

describe('settings preview expands fragments the way the runtime does', () => {
  it('shows the expanded fragment for every prompt template on the global surface', async () => {
    const config = makeConfig();
    config.promptFragments[FRAGMENT] = 'GLOBAL-FRAG';
    for (const [path, name] of Object.entries(globalTemplates)) {
      const keys = path.split('.');
      const leaf = keys.pop()!;
      const parent = keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, config as unknown as Record<string, unknown>);
      parent[leaf] = marker('G', name);
    }
    const ctx: GlobalRenderCtx = {
      surface: 'global', config, baseline: config, setConfig: () => {}, errors: {}, harnessPermissionModes: {},
      channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
    };
    const text = await previewText(ctx);
    for (const name of Object.values(globalTemplates)) expect(text, name).toContain(expanded('G', name, 'GLOBAL-FRAG'));
  });

  it('shows the Workspace-resolved fragment for every Workspace prompt override', async () => {
    const config = makeConfig();
    config.promptFragments[FRAGMENT] = 'GLOBAL-FRAG';
    const overrides: Record<string, unknown> = { [promptFragmentOverrideKey(FRAGMENT)]: 'WS-FRAG' };
    for (const name of Object.values(globalTemplates)) overrides[name] = marker('W', name);
    const workspace = { ...makeWorkspace(), ...overrides } as ReturnType<typeof makeWorkspace>;
    const ctx: WorkspaceRenderCtx = {
      surface: 'workspace', config, workspace, pristineWorkspace: workspace, setWorkspace: () => {}, errors: {},
      blockedByRunningTask: false, onRequestDelete: () => {},
    };
    const text = await previewText(ctx);
    for (const name of Object.values(globalTemplates)) expect(text, name).toContain(expanded('W', name, 'WS-FRAG'));
  });

  it('covers every global template in the shared field list', () => {
    const covered = Object.keys(globalTemplates);
    const listed = FRAGMENT_TEMPLATE_FIELDS.map((f) => f.config.join('.')).filter((p) => !p.includes('critics') && p !== 'verify.epic.resolvePrompt');
    expect(covered.sort()).toEqual(listed.sort());
  });

  it('previews critic prompts through the same builder as the runtime', () => {
    const config = makeConfig();
    config.promptFragments[FRAGMENT] = 'GLOBAL-FRAG';
    const operator = `critic<{fragment.${FRAGMENT}}>`;
    const [mirrored] = compileCriticPreview({ issuePrompt: operator, noIssuePrompt: operator }, config.promptFragments);
    const runtime = buildCriticPrompt({
      operatorPrompt: operator,
      fields: { taskId: '123', skill: '/implement', ref: '', url: '', title: '', description: '' },
      verifiedHeadOid: 'x',
      fragments: config.promptFragments,
    });
    expect(mirrored!.text).toContain('critic<GLOBAL-FRAG>');
    expect(runtime).toContain('critic<GLOBAL-FRAG>');
  });
});
