import {
  PROMPT_ANATOMIES,
  anatomyPartKeys,
  fragmentKey,
  partHelp,
  partLabel,
  templateKey,
  type AnatomyId,
  type AnatomyNode,
  type AnatomyOption,
  type AnatomyChoice,
  type AnatomyPart,
  type PartKey,
  type PromptAnatomy,
} from '../../../../src/domain/prompt-anatomy.js';
import {
  PROMPT_FRAGMENT_NAMES,
  promptFragmentOverrideKey,
  type PromptFragmentName,
  type PromptFragments,
} from '../../../../src/domain/prompt-fragments.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS, type PromptTemplateId } from '../../../../src/domain/prompt-templates.js';
import type { AppConfig, Workspace } from '../../types';
import type { RenderCtx } from '../settings-schema';
import { defaultConditions, fragmentPlaceholders, TEMPLATE_PLACEHOLDERS, type Placeholder, type SampleConditions } from '../../prompt-preview-model';

interface TemplateAccess {
  get: (c: AppConfig) => string;
  set: (c: AppConfig, v: string) => AppConfig;
}

const TEMPLATE_ACCESS: Record<PromptTemplateId, TemplateAccess> = {
  taskPrompt: { get: (c) => c.taskPrompt, set: (c, v) => ({ ...c, taskPrompt: v }) },
  drivePrompt: { get: (c) => c.drive.prompt, set: (c, v) => ({ ...c, drive: { ...c.drive, prompt: v } }) },
  unattendedReminder: { get: (c) => c.drive.unattendedReminder, set: (c, v) => ({ ...c, drive: { ...c.drive, unattendedReminder: v } }) },
  continuePrompt: { get: (c) => c.drive.continuePrompt, set: (c, v) => ({ ...c, drive: { ...c.drive, continuePrompt: v } }) },
  commitNudge: { get: (c) => c.drive.commitNudge, set: (c, v) => ({ ...c, drive: { ...c.drive, commitNudge: v } }) },
  pauseMessage: { get: (c) => c.pauseMessage, set: (c, v) => ({ ...c, pauseMessage: v }) },
  mergeConflictPrompt: { get: (c) => c.merge.conflictPrompt, set: (c, v) => ({ ...c, merge: { ...c.merge, conflictPrompt: v } }) },
  epicConflictPrompt: { get: (c) => c.merge.epicConflictPrompt, set: (c, v) => ({ ...c, merge: { ...c.merge, epicConflictPrompt: v } }) },
  epicRefreshPrompt: { get: (c) => c.merge.epicRefreshPrompt, set: (c, v) => ({ ...c, merge: { ...c.merge, epicRefreshPrompt: v } }) },
  epicResolvePrompt: {
    get: (c) => c.verify.epic.resolvePrompt,
    set: (c, v) => ({ ...c, verify: { ...c.verify, epic: { ...c.verify.epic, resolvePrompt: v } } }),
  },
  epicResolveSuffix: {
    get: (c) => c.verify.epic.resolveSuffix,
    set: (c, v) => ({ ...c, verify: { ...c.verify, epic: { ...c.verify.epic, resolveSuffix: v } } }),
  },
};

export type PartRef =
  | { kind: 'template'; id: PromptTemplateId }
  | { kind: 'fragment'; name: PromptFragmentName }
  | { kind: 'critic' };

export type EditableRef = Exclude<PartRef, { kind: 'critic' }>;

const TEMPLATE_BY_KEY = new Map<PartKey, PromptTemplateId>(PROMPT_TEMPLATE_IDS.map((id): [PartKey, PromptTemplateId] => [templateKey(id), id]));
const FRAGMENT_BY_KEY = new Map<PartKey, PromptFragmentName>(PROMPT_FRAGMENT_NAMES.map((name): [PartKey, PromptFragmentName] => [fragmentKey(name), name]));

export function partRef(key: PartKey): PartRef {
  const id = TEMPLATE_BY_KEY.get(key);
  if (id) return { kind: 'template', id };
  const name = FRAGMENT_BY_KEY.get(key);
  if (name) return { kind: 'fragment', name };
  return { kind: 'critic' };
}

export function placeholdersForKey(key: PartKey): Placeholder[] {
  const ref = partRef(key);
  if (ref.kind === 'template') return TEMPLATE_PLACEHOLDERS[ref.id];
  if (ref.kind === 'fragment') return fragmentPlaceholders(ref.name);
  return [];
}

export const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

interface Binding {
  getGlobal: (c: AppConfig) => string;
  setGlobal: (c: AppConfig, v: string) => AppConfig;
  globalError: string;
  workspaceKey: keyof Workspace | null;
  globalFieldId: string;
  workspaceFieldId: string;
}

function binding(ref: EditableRef): Binding {
  if (ref.kind === 'template') {
    const spec = PROMPT_TEMPLATES[ref.id];
    const access = TEMPLATE_ACCESS[ref.id];
    return {
      getGlobal: access.get,
      setGlobal: access.set,
      globalError: spec.config.join('.'),
      workspaceKey: spec.workspace,
      globalFieldId: `settings-${kebab(ref.id)}`,
      workspaceFieldId: `workspace-${kebab(ref.id)}`,
    };
  }
  const { name } = ref;
  return {
    getGlobal: (c) => c.promptFragments[name],
    setGlobal: (c, v) => ({ ...c, promptFragments: { ...c.promptFragments, [name]: v } }),
    globalError: `promptFragments.${name}`,
    workspaceKey: promptFragmentOverrideKey(name),
    globalFieldId: `settings-fragment-${kebab(name)}`,
    workspaceFieldId: `workspace-fragment-${kebab(name)}`,
  };
}

export function fieldId(ref: EditableRef, surface: RenderCtx['surface']): string {
  const b = binding(ref);
  return surface === 'global' ? b.globalFieldId : b.workspaceFieldId;
}

export function errorKey(ref: EditableRef, surface: RenderCtx['surface']): string | null {
  const b = binding(ref);
  return surface === 'global' ? b.globalError : b.workspaceKey;
}

function workspaceOverride(w: Workspace, key: keyof Workspace): string | null {
  const raw = w[key];
  return typeof raw === 'string' ? raw : null;
}

export interface PartState {
  value: string;
  inheritedValue: string;
  modified: boolean;
  editable: boolean;
  error: string | undefined;
}

export function editableState(ref: EditableRef, ctx: RenderCtx): PartState {
  const b = binding(ref);
  const key = errorKey(ref, ctx.surface);
  const error = key === null ? undefined : ctx.errors[key];
  if (ctx.surface === 'global') {
    const value = b.getGlobal(ctx.config);
    const inheritedValue = b.getGlobal(ctx.baseline);
    return { value, inheritedValue, modified: value !== inheritedValue, editable: true, error };
  }
  const inheritedValue = b.getGlobal(ctx.config);
  if (b.workspaceKey === null) return { value: inheritedValue, inheritedValue, modified: false, editable: false, error };
  const override = workspaceOverride(ctx.workspace, b.workspaceKey);
  return { value: override ?? inheritedValue, inheritedValue, modified: override !== null, editable: true, error };
}

export function partState(key: PartKey, ctx: RenderCtx): PartState | null {
  const ref = partRef(key);
  return ref.kind === 'critic' ? null : editableState(ref, ctx);
}

/** `null` reverts: to the distributed default on the global surface, to inheriting on a Workspace. */
export function writePart(key: PartKey, ctx: RenderCtx, value: string | null): void {
  const ref = partRef(key);
  if (ref.kind === 'critic') return;
  const b = binding(ref);
  if (ctx.surface === 'global') {
    ctx.setConfig(b.setGlobal(ctx.config, value ?? b.getGlobal(ctx.baseline)));
    return;
  }
  if (b.workspaceKey === null) return;
  ctx.setWorkspace({ ...ctx.workspace, [b.workspaceKey]: value });
}

export interface AnatomyCounts {
  parts: number;
  modified: number;
  errors: number;
}

function editableKeys(keys: readonly PartKey[], ctx: RenderCtx): { key: PartKey; state: PartState }[] {
  return keys.flatMap((key) => {
    const state = partState(key, ctx);
    return state?.editable ? [{ key, state }] : [];
  });
}

export function anatomyCounts(a: PromptAnatomy, ctx: RenderCtx): AnatomyCounts {
  const editable = editableKeys(anatomyPartKeys(a), ctx);
  return {
    parts: editable.length,
    modified: editable.filter((e) => e.state.modified).length,
    errors: editable.filter((e) => e.state.error !== undefined).length,
  };
}

export function totals(ctx: RenderCtx): { modified: number; total: number } {
  const keys = [...new Set(PROMPT_ANATOMIES.flatMap(anatomyPartKeys))];
  const editable = editableKeys(keys, ctx);
  return { modified: editable.filter((e) => e.state.modified).length, total: editable.length };
}

export function firstErroredPart(ctx: RenderCtx): { anatomy: AnatomyId; key: PartKey } | null {
  for (const a of PROMPT_ANATOMIES) {
    const hit = editableKeys(anatomyPartKeys(a), ctx).find((e) => e.state.error !== undefined);
    if (hit) return { anatomy: a.id, key: hit.key };
  }
  return null;
}

export interface SearchTextSource {
  template: (id: PromptTemplateId) => string;
  fragments: PromptFragments;
}

export interface SearchHit {
  anatomy: AnatomyId;
  anatomyTitle: string;
  key: PartKey;
  label: string;
  where: 'label' | 'help' | 'text';
}

const WHERE_RANK: Record<SearchHit['where'], number> = { label: 0, help: 1, text: 2 };

function partText(key: PartKey, view: SearchTextSource): string {
  const ref = partRef(key);
  if (ref.kind === 'template') return view.template(ref.id);
  if (ref.kind === 'fragment') return view.fragments[ref.name];
  return '';
}

export function searchParts(query: string, view: SearchTextSource): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const hits: SearchHit[] = [];
  for (const a of PROMPT_ANATOMIES) {
    for (const key of anatomyPartKeys(a)) {
      const where: SearchHit['where'] | null = partLabel(key).toLowerCase().includes(q)
        ? 'label'
        : partHelp(key).toLowerCase().includes(q)
          ? 'help'
          : partText(key, view).toLowerCase().includes(q)
            ? 'text'
            : null;
      if (where) hits.push({ anatomy: a.id, anatomyTitle: a.title, key, label: partLabel(key), where });
    }
  }
  return hits.sort((x, y) => WHERE_RANK[x.where] - WHERE_RANK[y.where]);
}

export interface Placement {
  key: PartKey;
  occurrence: number;
  /** Top-level step this placement sits in (1-based). */
  step: number;
  flags: string[];
  choices: [by: string, value: string][];
}

export type LayoutNode = LayoutPart | LayoutChoice;

export interface LayoutPart {
  kind: 'part';
  part: AnatomyPart;
  occurrence: number;
  nested: LayoutNode[];
}

export interface LayoutChoice {
  kind: 'oneOf';
  choice: AnatomyChoice;
  options: { option: AnatomyOption; nodes: LayoutNode[] }[];
}

export interface AnatomyLayout {
  steps: { step: number; node: LayoutNode }[];
  placements: Placement[];
}

interface Trail {
  flags: string[];
  choices: [string, string][];
}

function buildLayout(a: PromptAnatomy): AnatomyLayout {
  const counts = new Map<PartKey, number>();
  const placements: Placement[] = [];
  const buildNode = (node: AnatomyNode, trail: Trail, step: number): LayoutNode => {
    if (node.kind === 'oneOf') {
      return {
        kind: 'oneOf',
        choice: node,
        options: node.options.map((option) => ({
          option,
          nodes: option.parts.map((child) => buildNode(child, { ...trail, choices: [...trail.choices, [node.by, option.value]] }, step)),
        })),
      };
    }
    const occurrence = counts.get(node.key) ?? 0;
    counts.set(node.key, occurrence + 1);
    const flags = node.when !== undefined ? [...trail.flags, node.when] : trail.flags;
    placements.push({ key: node.key, occurrence, step, flags, choices: trail.choices });
    return { kind: 'part', part: node, occurrence, nested: (node.nested ?? []).map((child) => buildNode(child, { ...trail, flags }, step)) };
  };
  const steps = a.parts.map((node, i) => ({ step: i + 1, node: buildNode(node, { flags: [], choices: [] }, i + 1) }));
  return { steps, placements };
}

const LAYOUTS = new Map<AnatomyId, AnatomyLayout>();

export function anatomyLayout(a: PromptAnatomy): AnatomyLayout {
  const cached = LAYOUTS.get(a.id);
  if (cached) return cached;
  const built = buildLayout(a);
  LAYOUTS.set(a.id, built);
  return built;
}

export function anatomyById(id: AnatomyId): PromptAnatomy {
  const a = PROMPT_ANATOMIES.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown prompt anatomy: ${id}`);
  return a;
}

export function stepOfKey(layout: AnatomyLayout, key: PartKey): number | null {
  return layout.placements.find((p) => p.key === key)?.step ?? null;
}

export function isConditionalKey(layout: AnatomyLayout, key: PartKey): boolean {
  const first = layout.placements.find((p) => p.key === key);
  return first !== undefined && first.flags.length > 0;
}

export interface SelectorChoice {
  by: string;
  label: string;
  options: readonly AnatomyOption[];
}

export function anatomySelectors(a: PromptAnatomy): SelectorChoice[] {
  const found = new Map<string, SelectorChoice>();
  const visit = (nodes: readonly AnatomyNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'oneOf') {
        if (!found.has(node.by)) found.set(node.by, { by: node.by, label: node.label, options: node.options });
        for (const option of node.options) visit(option.parts);
      } else {
        visit(node.nested ?? []);
      }
    }
  };
  visit(a.parts);
  return [...found.values()];
}

export interface ExpandedPart {
  key: PartKey;
  occurrence: number;
}

export interface PromptsTabState {
  anatomy: AnatomyId;
  expanded: ExpandedPart | null;
  conditions: Readonly<Partial<Record<AnatomyId, SampleConditions>>>;
  query: string;
}

export function conditionsFor(state: PromptsTabState, id: AnatomyId): SampleConditions {
  return state.conditions[id] ?? defaultConditions(anatomyById(id));
}

export function initialState(): PromptsTabState {
  const [first] = PROMPT_ANATOMIES;
  if (!first) throw new Error('No prompt anatomies defined');
  return {
    anatomy: first.id,
    expanded: null,
    conditions: {},
    query: '',
  };
}

export function revealPartInPreview(state: PromptsTabState, anatomy: AnatomyId, key: PartKey, occurrence = 0): PromptsTabState {
  const layout = anatomyLayout(anatomyById(anatomy));
  const placement = layout.placements.find((p) => p.key === key && p.occurrence === occurrence) ?? layout.placements.find((p) => p.key === key);
  if (!placement) return state;
  const current = conditionsFor(state, anatomy);
  return {
    ...state,
    anatomy,
    expanded: { key, occurrence: placement.occurrence },
    conditions: {
      ...state.conditions,
      [anatomy]: {
        flags: { ...current.flags, ...Object.fromEntries(placement.flags.map((f) => [f, true])) },
        choices: { ...current.choices, ...Object.fromEntries(placement.choices) },
      },
    },
  };
}

export type PromptsTabAction =
  | { type: 'selectAnatomy'; anatomy: AnatomyId }
  | { type: 'toggle'; key: PartKey; occurrence: number }
  | { type: 'collapse' }
  | { type: 'jump'; anatomy: AnatomyId; key: PartKey }
  | { type: 'query'; query: string }
  | { type: 'flag'; id: string; on: boolean }
  | { type: 'choice'; by: string; value: string };

export function reduce(state: PromptsTabState, action: PromptsTabAction): PromptsTabState {
  switch (action.type) {
    case 'selectAnatomy':
      return state.anatomy === action.anatomy ? state : { ...state, anatomy: action.anatomy, expanded: null };
    case 'toggle':
      if (state.expanded?.key === action.key && state.expanded.occurrence === action.occurrence) return { ...state, expanded: null };
      return revealPartInPreview(state, state.anatomy, action.key, action.occurrence);
    case 'collapse':
      return { ...state, expanded: null };
    case 'jump':
      return { ...revealPartInPreview(state, action.anatomy, action.key), query: '' };
    case 'query':
      return { ...state, query: action.query };
    case 'flag': {
      const current = conditionsFor(state, state.anatomy);
      return { ...state, conditions: { ...state.conditions, [state.anatomy]: { ...current, flags: { ...current.flags, [action.id]: action.on } } } };
    }
    case 'choice': {
      const current = conditionsFor(state, state.anatomy);
      return { ...state, conditions: { ...state.conditions, [state.anatomy]: { ...current, choices: { ...current.choices, [action.by]: action.value } } } };
    }
  }
}
