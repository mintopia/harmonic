// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PROMPT_ANATOMIES, anatomyPartKeys } from '../src/domain/prompt-anatomy.js';
import { PROMPT_FRAGMENT_NAMES } from '../src/domain/prompt-fragments.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS } from '../src/domain/prompt-templates.js';
import type { GlobalRenderCtx, WorkspaceRenderCtx } from '../web/src/components/settings-schema.js';
import {
  anatomyById,
  anatomyCounts,
  firstErroredPart,
  initialState,
  partState,
  reduce,
  searchParts,
  revealPartInPreview,
  totals,
  writePart,
} from '../web/src/components/prompts/prompts-tab-model.js';
import { layoutModeFor } from '../web/src/components/prompts/use-layout-mode.js';
import { promptSettingsView } from '../web/src/prompt-preview-model.js';
import { makeConfig, makeWorkspace } from './component-smoke-harness.js';

function valueAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const seg of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = Object.entries(node).find(([k]) => k === seg)?.[1];
  }
  return node;
}

function globalCtx(over: Partial<GlobalRenderCtx> = {}): GlobalRenderCtx {
  const config = makeConfig();
  return {
    surface: 'global',
    config,
    baseline: config,
    setConfig: () => {},
    errors: {},
    harnessPermissionModes: {},
    channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
    ...over,
  };
}

function workspaceCtx(over: Partial<WorkspaceRenderCtx> = {}): WorkspaceRenderCtx {
  const workspace = makeWorkspace();
  return {
    surface: 'workspace',
    config: makeConfig(),
    workspace,
    pristineWorkspace: workspace,
    setWorkspace: () => {},
    errors: {},
    blockedByRunningTask: false,
    onRequestDelete: () => {},
    ...over,
  };
}

describe('totals and counts', () => {
  it('counts every template and fragment once on the global surface', () => {
    const t = totals(globalCtx());
    expect(t.total).toBe(PROMPT_TEMPLATE_IDS.length + PROMPT_FRAGMENT_NAMES.length);
    expect(t.modified).toBe(0);
  });

  it('excludes the global-only Epic resolve prompt on a Workspace', () => {
    expect(totals(workspaceCtx()).total).toBe(PROMPT_TEMPLATE_IDS.length + PROMPT_FRAGMENT_NAMES.length - 1);
  });

  it('marks a global part modified when it differs from the baseline', () => {
    const base = makeConfig();
    const config = { ...base, drive: { ...base.drive, prompt: 'edited' } };
    const ctx = globalCtx({ config, baseline: base });
    expect(partState('template:drivePrompt', ctx)?.modified).toBe(true);
    expect(totals(ctx).modified).toBe(1);
    const implementation = anatomyById('implementation');
    expect(anatomyCounts(implementation, ctx).modified).toBe(1);
    expect(anatomyCounts(anatomyById('nudges'), ctx).modified).toBe(0);
  });

  it('marks a Workspace part modified only when it overrides', () => {
    const ctx = workspaceCtx({ workspace: makeWorkspace({ drivePrompt: 'ws' }) });
    expect(partState('template:drivePrompt', ctx)).toMatchObject({ value: 'ws', modified: true, editable: true });
    expect(partState('template:taskPrompt', ctx)).toMatchObject({ modified: false, editable: true });
    expect(totals(ctx).modified).toBe(1);
  });

  it('makes the Epic resolve prompt read-only on a Workspace', () => {
    expect(partState('template:epicResolvePrompt', workspaceCtx())).toMatchObject({ editable: false, modified: false });
  });

  it('has no state for the per-critic prompt', () => {
    expect(partState('criticPrompt', globalCtx())).toBeNull();
  });

  it('counts errors per anatomy and finds the first errored part', () => {
    const ctx = globalCtx({ errors: { 'merge.conflictPrompt': 'Required' } });
    expect(anatomyCounts(anatomyById('mergeConflicts'), ctx).errors).toBe(1);
    expect(firstErroredPart(ctx)).toEqual({ anatomy: 'mergeConflicts', key: 'template:mergeConflictPrompt' });
    expect(firstErroredPart(globalCtx())).toBeNull();
  });

  it('reads Workspace errors by override key', () => {
    const ctx = workspaceCtx({ errors: { promptFragmentSelfHeal: 'Required' } });
    expect(firstErroredPart(ctx)).toEqual({ anatomy: 'implementation', key: 'fragment:selfHeal' });
  });
});

describe('writePart', () => {
  it('writes and reverts a global template by its config path', () => {
    const base = makeConfig();
    let latest = base;
    const ctx = globalCtx({ config: base, baseline: { ...base, drive: { ...base.drive, prompt: 'distributed' } }, setConfig: (c) => (latest = c) });
    writePart('template:drivePrompt', ctx, 'new');
    expect(latest.drive.prompt).toBe('new');
    writePart('template:drivePrompt', ctx, null);
    expect(latest.drive.prompt).toBe('distributed');
  });

  it('writes every template to the path PROMPT_TEMPLATES declares', () => {
    for (const id of PROMPT_TEMPLATE_IDS) {
      let latest = makeConfig();
      const ctx = globalCtx({ setConfig: (c) => (latest = c) });
      writePart(`template:${id}`, ctx, 'X');
      expect(valueAt(latest, PROMPT_TEMPLATES[id].config), id).toBe('X');
    }
  });

  it('writes a Workspace override and reverts to null', () => {
    let latest = makeWorkspace();
    const ctx = workspaceCtx({ setWorkspace: (w) => (latest = w) });
    writePart('fragment:selfHeal', ctx, 'mine');
    expect(latest.promptFragmentSelfHeal).toBe('mine');
    writePart('fragment:selfHeal', ctx, null);
    expect(latest.promptFragmentSelfHeal).toBeNull();
  });

  it('ignores writes to the global-only template on a Workspace', () => {
    let called = false;
    writePart('template:epicResolvePrompt', workspaceCtx({ setWorkspace: () => (called = true) }), 'x');
    expect(called).toBe(false);
  });
});

describe('searchParts', () => {
  const view = promptSettingsView({ config: makeConfig({ drive: { ...makeConfig().drive, prompt: 'zebra-token here' } }) });

  it('matches label, then help, then text, case-insensitively', () => {
    expect(searchParts('DRIVE PROMPT', view)[0]).toMatchObject({ key: 'template:drivePrompt', where: 'label' });
    expect(searchParts('zebra-token', view)).toEqual([expect.objectContaining({ key: 'template:drivePrompt', where: 'text' })]);
    const help = searchParts('mirrored ticket unattended', view);
    expect(help.every((h) => h.where !== 'text')).toBe(true);
  });

  it('returns a hit per anatomy a shared part appears in', () => {
    const hits = searchParts('Unattended reminder', view).filter((h) => h.where === 'label');
    expect(hits.map((h) => h.anatomy).sort()).toEqual(['implementation', 'nudges']);
  });

  it('is empty for a blank query', () => {
    expect(searchParts('   ', view)).toEqual([]);
  });
});

describe('revealPartInPreview', () => {
  it('switches the containing oneOf option and turns on the flags that gate the part', () => {
    const next = revealPartInPreview(initialState(), 'implementation', 'template:drivePrompt');
    expect(next.expanded).toEqual({ key: 'template:drivePrompt', occurrence: 0 });
    expect(next.conditions.implementation?.choices.origin).toBe('mirrored');
    const heal = revealPartInPreview(initialState(), 'implementation', 'fragment:selfHeal');
    expect(heal.conditions.implementation?.flags.selfHeal).toBe(true);
  });

  it('enables parent flags for a nested part', () => {
    const next = revealPartInPreview(initialState(), 'implementation', 'fragment:peerMessage');
    expect(next.conditions.implementation?.flags.heldPeerMessages).toBe(true);
  });

  it('selects a later occurrence of a shared part with its own option', () => {
    const epic = revealPartInPreview(initialState(), 'mergeConflicts', 'fragment:conflictResolution', 1);
    expect(epic.conditions.mergeConflicts?.choices.resolver).toBe('epic');
    expect(epic.expanded).toEqual({ key: 'fragment:conflictResolution', occurrence: 1 });
  });

  it('leaves state alone for a part not in the anatomy', () => {
    const start = initialState();
    expect(revealPartInPreview(start, 'nudges', 'template:drivePrompt')).toBe(start);
  });
});

describe('reduce', () => {
  it('collapses an open part when toggled again and resets expansion on anatomy change', () => {
    const open = reduce(initialState(), { type: 'toggle', key: 'template:taskPrompt', occurrence: 0 });
    expect(open.expanded?.key).toBe('template:taskPrompt');
    expect(reduce(open, { type: 'toggle', key: 'template:taskPrompt', occurrence: 0 }).expanded).toBeNull();
    expect(reduce(open, { type: 'selectAnatomy', anatomy: 'nudges' })).toMatchObject({ anatomy: 'nudges', expanded: null });
  });

  it('jump selects across anatomies and clears the query', () => {
    const searching = reduce(initialState(), { type: 'query', query: 'commit' });
    const jumped = reduce(searching, { type: 'jump', anatomy: 'nudges', key: 'template:commitNudge' });
    expect(jumped).toMatchObject({ anatomy: 'nudges', query: '' });
    expect(jumped.conditions.nudges?.choices.event).toBe('commit');
  });

  it('sets flags and choices for the active anatomy only', () => {
    const s = reduce(reduce(initialState(), { type: 'flag', id: 'selfHeal', on: true }), { type: 'choice', by: 'origin', value: 'mirrored' });
    expect(s.conditions.implementation?.flags.selfHeal).toBe(true);
    expect(s.conditions.implementation?.choices.origin).toBe('mirrored');
    expect(s.conditions.nudges).toBeUndefined();
  });
});

describe('anatomy coverage and layout mode', () => {
  it('places every template and fragment in some anatomy', () => {
    const keys = new Set(PROMPT_ANATOMIES.flatMap(anatomyPartKeys));
    for (const id of PROMPT_TEMPLATE_IDS) expect(keys.has(`template:${id}`), id).toBe(true);
    for (const name of PROMPT_FRAGMENT_NAMES) expect(keys.has(`fragment:${name}`), name).toBe(true);
  });

  it('picks the layout from the panel width, treating an unmeasured panel as wide', () => {
    expect([0, 1200, 1024, 900, 704, 703, 390].map(layoutModeFor)).toEqual(['wide', 'wide', 'wide', 'medium', 'medium', 'narrow', 'narrow']);
  });
});
