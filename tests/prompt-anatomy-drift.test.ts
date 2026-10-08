import { describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import {
  PROMPT_ANATOMIES,
  anatomyPartKeys,
  fragmentKey,
  templateKey,
  type AnatomyNode,
  type PartKey,
  type PromptAnatomy,
} from '../src/domain/prompt-anatomy.js';
import { FRAGMENT_TEMPLATE_FIELDS, PROMPT_FRAGMENTS, PROMPT_FRAGMENT_NAMES } from '../src/domain/prompt-fragments.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS } from '../src/domain/prompt-templates.js';
import {
  assemblePreview,
  defaultConditions,
  promptSettingsView,
  type PreviewSegment,
  type PromptSettingsView,
} from '../web/src/prompt-preview-model.js';

interface Shape {
  key: PartKey;
  children: Shape[];
}

type Flags = Record<string, boolean>;

function selectors(nodes: readonly AnatomyNode[], into: Map<string, Set<string>>): Map<string, Set<string>> {
  for (const node of nodes) {
    if (node.kind === 'part') {
      selectors(node.nested ?? [], into);
      continue;
    }
    const values = into.get(node.by) ?? new Set<string>();
    for (const option of node.options) {
      values.add(option.value);
      selectors(option.parts, into);
    }
    into.set(node.by, values);
  }
  return into;
}

function combinations(a: PromptAnatomy): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [by, values] of selectors(a.parts, new Map())) {
    combos = combos.flatMap((combo) => [...values].map((value) => ({ ...combo, [by]: value })));
  }
  return combos;
}

function expectedShape(nodes: readonly AnatomyNode[], choices: Record<string, string>, flags: Flags): Shape[] {
  return nodes.flatMap((node): Shape[] => {
    if (node.kind === 'oneOf') {
      const chosen = node.options.find((option) => option.value === choices[node.by]);
      return chosen ? expectedShape(chosen.parts, choices, flags) : [];
    }
    if (node.when && !flags[node.when]) return [];
    return [{ key: node.key, children: expectedShape(node.nested ?? [], choices, flags) }];
  });
}

function firstOccurrences(shapes: Shape[]): Shape[] {
  const seen = new Set<PartKey>();
  return shapes.flatMap((s): Shape[] => {
    if (seen.has(s.key)) return [];
    seen.add(s.key);
    return [{ key: s.key, children: firstOccurrences(s.children) }];
  });
}

function actualShape(segments: readonly (string | PreviewSegment)[]): Shape[] {
  const shapes = segments.flatMap((segment): Shape[] =>
    typeof segment === 'string' || segment.key === null ? [] : [{ key: segment.key, children: actualShape(segment.children) }],
  );
  return firstOccurrences(shapes);
}

function runtimeShape(a: PromptAnatomy, choices: Record<string, string>, flags: Flags): Shape[] {
  if (a.id === 'criticReview' && flags.dirtyWorktree && choices.revision === 'identical') return expectedShape(a.parts, { ...choices, revision: 'diff' }, flags);
  if (a.id !== 'implementation') return expectedShape(a.parts, choices, flags);
  const effective: Flags = { ...flags, heldPeerMessages: flags.heldPeerMessages === true && flags.agentMessages === true };
  const shape = expectedShape(a.parts, choices, effective);
  if (!(effective.operatorSeeded && effective.priorSession && !effective.selfHeal)) return shape;
  const opening = new Set<PartKey>([templateKey('taskPrompt'), templateKey('drivePrompt'), templateKey('unattendedReminder')]);
  const prior = shape.filter((s) => s.key === 'fragment:priorSession');
  return [...prior, ...shape.filter((s) => !opening.has(s.key) && s.key !== 'fragment:priorSession')];
}

function markerView(): PromptSettingsView {
  const references = new Map<PartKey, PartKey[]>();
  const visit = (nodes: readonly AnatomyNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'oneOf') {
        for (const option of node.options) visit(option.parts);
        continue;
      }
      for (const child of node.nested ?? []) {
        if (child.kind === 'part' && child.via === 'reference') references.set(node.key, [...(references.get(node.key) ?? []), child.key]);
      }
      visit(node.nested ?? []);
    }
  };
  for (const a of PROMPT_ANATOMIES) visit(a.parts);
  const refText = (key: PartKey) =>
    (references.get(key) ?? []).map((child) => `{fragment.${child.replace('fragment:', '')}}`).join(' ');
  const fragments = Object.fromEntries(
    PROMPT_FRAGMENT_NAMES.map((name) => [name, [...Object.keys(PROMPT_FRAGMENTS[name].fields).map((f) => `{${f}}`), refText(fragmentKey(name))].join(' ')]),
  );
  const base = promptSettingsView({ config: baselineConfig() });
  return {
    template: (id) => refText(templateKey(id)),
    fragments: { ...base.fragments, ...fragments },
    criticPrompt: { name: 'Marker critic', issue: 'issue prompt', noIssue: 'no issue prompt' },
  };
}

const VIEWS: [string, () => PromptSettingsView][] = [
  ['marker text', markerView],
  ['baseline defaults', () => promptSettingsView({ config: baselineConfig() })],
];

describe.each(VIEWS)('prompt anatomy drift (%s)', (_name, makeView) => {
  describe.each(PROMPT_ANATOMIES.map((a) => [a.id, a] as const))('%s', (_id, anatomy) => {
    const allOn: Flags = Object.fromEntries(anatomy.flags.map((f) => [f.id, true]));

    it.each(combinations(anatomy).map((choices) => [JSON.stringify(choices), choices] as const))(
      'real assembly matches the anatomy with every flag on: %s',
      (_label, choices) => {
        const segments = assemblePreview(anatomy.id, makeView(), { flags: allOn, choices });
        expect(actualShape(segments)).toEqual(runtimeShape(anatomy, choices, allOn));
      },
    );

    it.each(anatomy.flags.flatMap((f) => combinations(anatomy).map((choices) => [`${f.id} off, ${JSON.stringify(choices)}`, f.id, choices] as const)))(
      'turning a flag off removes only its parts: %s',
      (_label, flagId, choices) => {
        const flags = { ...allOn, [flagId]: false };
        const segments = assemblePreview(anatomy.id, makeView(), { flags, choices });
        expect(actualShape(segments)).toEqual(runtimeShape(anatomy, choices, flags));
      },
    );

    it('every flag off leaves only the unconditional parts', () => {
      const flags: Flags = Object.fromEntries(anatomy.flags.map((f) => [f.id, false]));
      for (const choices of combinations(anatomy)) {
        const segments = assemblePreview(anatomy.id, makeView(), { flags, choices });
        expect(actualShape(segments)).toEqual(runtimeShape(anatomy, choices, flags));
      }
    });

    it('defaultConditions assemble without error', () => {
      expect(assemblePreview(anatomy.id, makeView(), defaultConditions(anatomy)).length).toBeGreaterThan(0);
    });
  });
});

describe('prompt anatomy declarations', () => {
  it('a reference-nested part is referenced in its parent default text', () => {
    const view = promptSettingsView({ config: baselineConfig() });
    const defaults = new Map<PartKey, string>([
      ...PROMPT_TEMPLATE_IDS.map((id): [PartKey, string] => [templateKey(id), view.template(id)]),
      ...PROMPT_FRAGMENT_NAMES.map((name): [PartKey, string] => [fragmentKey(name), view.fragments[name]]),
    ]);
    const check = (nodes: readonly AnatomyNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'oneOf') {
          for (const option of node.options) check(option.parts);
          continue;
        }
        const text = defaults.get(node.key) ?? '';
        for (const child of node.nested ?? []) {
          if (child.kind === 'part' && child.via === 'reference') expect(text, `${node.key} references ${child.key}`).toContain(`{${child.key.replace(':', '.')}}`);
        }
        check(node.nested ?? []);
      }
    };
    for (const a of PROMPT_ANATOMIES) check(a.parts);
  });

  it('only gates parts on flags the anatomy declares', () => {
    const check = (a: PromptAnatomy, nodes: readonly AnatomyNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'oneOf') {
          for (const option of node.options) check(a, option.parts);
          continue;
        }
        if (node.when !== undefined) expect(a.flags.map((f) => f.id), `${a.id}: ${node.key}`).toContain(node.when);
        check(a, node.nested ?? []);
      }
    };
    for (const a of PROMPT_ANATOMIES) check(a, a.parts);
  });

  it('places every fragment and template in at least one anatomy', () => {
    const placed = new Set(PROMPT_ANATOMIES.flatMap(anatomyPartKeys));
    for (const name of PROMPT_FRAGMENT_NAMES) expect(placed.has(fragmentKey(name)), name).toBe(true);
    for (const id of PROMPT_TEMPLATE_IDS) expect(placed.has(templateKey(id)), id).toBe(true);
  });

  it('keeps the fragment-expanding field list in step with the templates', () => {
    const critic = (path: readonly string[]) => path.includes('critics');
    const listed = FRAGMENT_TEMPLATE_FIELDS.filter((f) => !critic(f.config)).map((f) => f.config.join('.'));
    expect(listed.sort()).toEqual(PROMPT_TEMPLATE_IDS.map((id) => PROMPT_TEMPLATES[id].config.join('.')).sort());
  });
});
