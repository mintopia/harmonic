// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { promptFragmentOverrideKey } from '../src/domain/prompt-fragments.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS, type PromptTemplateId } from '../src/domain/prompt-templates.js';
import { templateKey, type AnatomyId } from '../src/domain/prompt-anatomy.js';
import { assemblePreview, compileCriticPreview, defaultConditions, promptSettingsView, type PreviewSegment } from '../web/src/prompt-preview-model.js';
import { PROMPT_ANATOMIES } from '../src/domain/prompt-anatomy.js';
import { buildCriticPrompt } from '../src/verification/critic-prompt.js';
import { makeConfig, makeWorkspace } from './component-smoke-harness.js';

const FRAGMENT = 'conflictResolution';
const marker = (scope: string, id: string) => `${scope}:${id}<{fragment.${FRAGMENT}}>`;
const expanded = (scope: string, id: string, text: string) => `${scope}:${id}<${text}>`;

const WHERE: Record<PromptTemplateId, { anatomy: AnatomyId; choices: Record<string, string> }> = {
  taskPrompt: { anatomy: 'implementation', choices: { origin: 'native' } },
  drivePrompt: { anatomy: 'implementation', choices: { origin: 'mirrored' } },
  unattendedReminder: { anatomy: 'nudges', choices: { event: 'continue' } },
  continuePrompt: { anatomy: 'nudges', choices: { event: 'continue' } },
  commitNudge: { anatomy: 'nudges', choices: { event: 'commit' } },
  pauseMessage: { anatomy: 'nudges', choices: { event: 'pause' } },
  mergeConflictPrompt: { anatomy: 'mergeConflicts', choices: { resolver: 'task' } },
  epicConflictPrompt: { anatomy: 'mergeConflicts', choices: { resolver: 'epic' } },
  epicRefreshPrompt: { anatomy: 'mergeConflicts', choices: { resolver: 'refresh' } },
  epicResolvePrompt: { anatomy: 'epicFix', choices: {} },
  epicResolveSuffix: { anatomy: 'epicFix', choices: {} },
};

const flatten = (segment: PreviewSegment): string =>
  segment.children.map((child) => (typeof child === 'string' ? child : flatten(child))).join('');

function textOf(segments: readonly (string | PreviewSegment)[], key: string): string | null {
  for (const segment of segments) {
    if (typeof segment === 'string') continue;
    if (segment.key === key) return flatten(segment);
    const inner = textOf(segment.children, key);
    if (inner !== null) return inner;
  }
  return null;
}

function setPath(root: object, path: readonly string[], value: string): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    Reflect.set(root, head, value);
    return;
  }
  const next: unknown = Reflect.get(root, head);
  if (next !== null && typeof next === 'object') setPath(next, rest, value);
}

const compiled = (view: ReturnType<typeof promptSettingsView>, id: PromptTemplateId) => {
  const where = WHERE[id];
  const anatomy = PROMPT_ANATOMIES.find((a) => a.id === where.anatomy);
  if (!anatomy) throw new Error(`no anatomy ${where.anatomy}`);
  const conditions = defaultConditions(anatomy);
  return textOf(assemblePreview(where.anatomy, view, { ...conditions, choices: { ...conditions.choices, ...where.choices } }), templateKey(id));
};

describe('settings preview expands fragments the way the runtime does', () => {
  it('shows the expanded fragment for every prompt template on the global surface', () => {
    const config = makeConfig();
    config.promptFragments[FRAGMENT] = 'GLOBAL-FRAG';
    for (const id of PROMPT_TEMPLATE_IDS) setPath(config, PROMPT_TEMPLATES[id].config, marker('G', id));
    const view = promptSettingsView({ config });
    for (const id of PROMPT_TEMPLATE_IDS) expect(compiled(view, id), id).toContain(expanded('G', id, 'GLOBAL-FRAG'));
  });

  it('shows the Workspace-resolved fragment for every Workspace prompt override', () => {
    const config = makeConfig();
    config.promptFragments[FRAGMENT] = 'GLOBAL-FRAG';
    for (const id of PROMPT_TEMPLATE_IDS) setPath(config, PROMPT_TEMPLATES[id].config, marker('G', id));
    const overrides: Record<string, unknown> = { [promptFragmentOverrideKey(FRAGMENT)]: 'WS-FRAG' };
    for (const id of PROMPT_TEMPLATE_IDS) {
      const key = PROMPT_TEMPLATES[id].workspace;
      if (key) overrides[key] = marker('W', id);
    }
    const workspace = { ...makeWorkspace(), ...overrides } as ReturnType<typeof makeWorkspace>;
    const view = promptSettingsView({ config, workspace });
    for (const id of PROMPT_TEMPLATE_IDS) {
      const overridable = PROMPT_TEMPLATES[id].workspace !== null;
      expect(compiled(view, id), id).toContain(overridable ? expanded('W', id, 'WS-FRAG') : expanded('G', id, 'WS-FRAG'));
    }
  });

  it('locates every template in an anatomy', () => {
    expect(Object.keys(WHERE).sort()).toEqual([...PROMPT_TEMPLATE_IDS].sort());
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
