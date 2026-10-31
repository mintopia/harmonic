import { isMap, isSeq, LineCounter, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { conditionBody } from '../../src/domain/workflow-expression.js';
import { WORKFLOW_ACTIONS } from '../../src/domain/workflow.js';

export type StepAction = (typeof WORKFLOW_ACTIONS)[number];
export type BuilderPath = readonly (string | number)[];

export interface BuilderStep {
  kind: 'step';
  path: BuilderPath;
  line: number;
  endLine: number;
  id: string;
  uses?: string;
  run?: string;
  harness?: string;
  model?: string;
  prompt?: string;
  condition?: string;
}

export interface BuilderParallel {
  kind: 'parallel';
  path: BuilderPath;
  line: number;
  endLine: number;
  id: string;
  condition?: string;
  children: BuilderStep[];
}

export interface BuilderAttempts {
  kind: 'attempts';
  path: BuilderPath;
  line: number;
  endLine: number;
  max: string;
  children: (BuilderStep | BuilderParallel)[];
}

export type BuilderNode = BuilderStep | BuilderParallel | BuilderAttempts;

export interface BuilderTree {
  steps: (BuilderStep | BuilderAttempts)[];
  cleanup: (BuilderStep | BuilderParallel)[];
}

export type PaletteItem =
  | { kind: 'action'; action: string; hint: string }
  | { kind: 'parallel'; hint: string }
  | { kind: 'attempts'; hint: string }
  | { kind: 'run'; hint: string };

export const PALETTE: readonly { title: string; items: readonly (PaletteItem & { label: string })[] }[] = [
  {
    title: 'Workflow Actions',
    items: [
      ['rebase', 'git'],
      ['agent', 'prompt'],
      ['command', 'shell'],
      ['critic', 'verdict'],
      ['merge', 'Merge'],
      ['open-pr', 'PR'],
      ['artifact', 'file'],
      ['post-merge-check', 'check'],
      ['close-ticket', 'tracker'],
      ['comment', 'tracker'],
      ['cleanup', 'end'],
    ].map(([action, hint]) => ({ kind: 'action' as const, label: action!, action: action!, hint: hint! })),
  },
  {
    title: 'Containers',
    items: [
      { kind: 'parallel', label: 'parallel', hint: 'group' },
      { kind: 'attempts', label: 'attempts', hint: 'bounded' },
    ],
  },
  { title: 'Other', items: [{ kind: 'run', label: 'run:', hint: 'shell' }] },
];

export function pathKey(path: BuilderPath): string {
  return path.join('/');
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined);

function lines(lc: LineCounter, node: unknown): [number, number] {
  const range = (node as { range?: [number, number, number] | null } | undefined)?.range;
  if (!range) return [1, 1];
  return [lc.linePos(range[0]).line, lc.linePos(Math.max(range[0], range[1] - 1)).line];
}

function readStep(doc: Document, lc: LineCounter, path: BuilderPath): BuilderStep | undefined {
  const node = doc.getIn(path, true);
  if (!isMap(node)) return undefined;
  const [line, endLine] = lines(lc, node);
  const get = (key: string): string | undefined => str(node.get(key));
  const w = node.get('with', true);
  const withGet = (key: string): string | undefined => (isMap(w) ? str(w.get(key)) : undefined);
  const cond = get('if');
  const step: BuilderStep = { kind: 'step', path, line, endLine, id: get('id') ?? '' };
  const optional: [keyof BuilderStep, string | undefined][] = [
    ['uses', get('uses')],
    ['run', get('run')],
    ['harness', withGet('harness')],
    ['model', withGet('model')],
    ['prompt', withGet('prompt')],
    ['condition', cond === undefined ? undefined : conditionBody(cond).source],
  ];
  for (const [key, value] of optional) if (value !== undefined) (step as unknown as Record<string, unknown>)[key] = value;
  return step;
}

function readLeafOrGroup(doc: Document, lc: LineCounter, path: BuilderPath): BuilderStep | BuilderParallel | undefined {
  const node = doc.getIn(path, true);
  if (!isMap(node)) return undefined;
  const group = node.get('parallel', true);
  if (!isSeq(group)) return readStep(doc, lc, path);
  const [line, endLine] = lines(lc, node);
  const cond = str(node.get('if'));
  const out: BuilderParallel = { kind: 'parallel', path, line, endLine, id: str(node.get('id')) ?? '', children: [] };
  if (cond !== undefined) out.condition = conditionBody(cond).source;
  group.items.forEach((_, i) => {
    const child = readStep(doc, lc, [...path, 'parallel', i]);
    if (child) out.children.push(child);
  });
  return out;
}

export function readBuilder(text: string): BuilderTree | null {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const tree: BuilderTree = { steps: [], cleanup: [] };
  const steps = doc.get('steps', true);
  if (isSeq(steps)) {
    steps.items.forEach((item, i) => {
      const path: BuilderPath = ['steps', i];
      if (isMap(item) && item.has('attempts')) {
        const body = item.get('attempts', true);
        const inner = isMap(body) ? body.get('steps', true) : undefined;
        const [line, endLine] = lines(lc, item);
        const max = isMap(body) ? str(body.get('max')) ?? '' : '';
        const attempts: BuilderAttempts = { kind: 'attempts', path, line, endLine, max, children: [] };
        if (isSeq(inner)) {
          inner.items.forEach((_, j) => {
            const child = readLeafOrGroup(doc, lc, [...path, 'attempts', 'steps', j]);
            if (child) attempts.children.push(child);
          });
        }
        tree.steps.push(attempts);
      } else {
        const step = readStep(doc, lc, path);
        if (step) tree.steps.push(step);
      }
    });
  }
  const cleanup = doc.get('cleanup', true);
  if (isSeq(cleanup)) {
    cleanup.items.forEach((_, i) => {
      const child = readLeafOrGroup(doc, lc, ['cleanup', i]);
      if (child) tree.cleanup.push(child);
    });
  }
  return tree;
}

/** The deepest builder block whose lines hold each issue line, keyed by `pathKey`. */
export function issuesByBlock<T extends { line: number }>(tree: BuilderTree, issues: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const find = (nodes: readonly BuilderNode[], line: number): BuilderNode | undefined => {
    for (const node of nodes) {
      if (line < node.line || line > node.endLine) continue;
      const children = node.kind === 'step' ? [] : node.children;
      return find(children, line) ?? node;
    }
    return undefined;
  };
  for (const issue of issues) {
    const hit = find([...tree.steps, ...tree.cleanup], issue.line);
    if (hit === undefined) continue;
    const key = pathKey(hit.path);
    out.set(key, [...(out.get(key) ?? []), issue]);
  }
  return out;
}

function edit(text: string, change: (doc: Document) => void): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return text;
  change(doc);
  return doc.toString({ lineWidth: 0 });
}

function allIds(doc: Document): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (isMap(node)) {
      const id = node.get('id');
      if (typeof id === 'string') ids.add(id);
      for (const pair of node.items) walk(pair.value);
    } else if (isSeq(node)) node.items.forEach(walk);
  };
  walk(doc.contents);
  return ids;
}

function freshId(doc: Document, base: string): string {
  const ids = allIds(doc);
  const root = base.replace(/[^a-z0-9_-]/g, '') || 'step';
  if (!ids.has(root)) return root;
  let n = 2;
  while (ids.has(`${root}-${n}`)) n++;
  return `${root}-${n}`;
}

function seqAt(doc: Document, container: BuilderPath): YAMLSeq | undefined {
  const node = doc.getIn(container, true);
  return isSeq(node) ? node : undefined;
}

export function paletteSpec(doc: Document, item: PaletteItem): unknown {
  if (item.kind === 'action') return { id: freshId(doc, item.action), uses: item.action };
  if (item.kind === 'run') return { id: freshId(doc, 'run'), run: 'true' };
  if (item.kind === 'parallel') return { id: freshId(doc, 'parallel'), parallel: [{ id: freshId(doc, 'check'), run: 'true' }] };
  return { attempts: { max: 2, steps: [{ id: freshId(doc, 'step'), run: 'true' }] } };
}

export function addBlock(text: string, container: BuilderPath, index: number, item: PaletteItem): string {
  return edit(text, (doc) => {
    const seq = seqAt(doc, container);
    if (!seq) return;
    seq.items.splice(Math.min(Math.max(index, 0), seq.items.length), 0, doc.createNode(paletteSpec(doc, item)));
  });
}

function parentOf(doc: Document, path: BuilderPath): { seq: YAMLSeq; index: number } | undefined {
  const index = path[path.length - 1];
  if (typeof index !== 'number') return undefined;
  const seq = seqAt(doc, path.slice(0, -1));
  return seq ? { seq, index } : undefined;
}

export function removeBlock(text: string, path: BuilderPath): string {
  return edit(text, (doc) => {
    const at = parentOf(doc, path);
    if (at) at.seq.items.splice(at.index, 1);
  });
}

export function moveBlock(text: string, from: BuilderPath, container: BuilderPath, index: number): string {
  return edit(text, (doc) => {
    const source = parentOf(doc, from);
    const target = seqAt(doc, container);
    if (!source || !target) return;
    const [node] = source.seq.items.splice(source.index, 1);
    if (node === undefined) return;
    const at = source.seq === target && source.index < index ? index - 1 : index;
    target.items.splice(Math.min(Math.max(at, 0), target.items.length), 0, node);
  });
}

export function setStepField(text: string, path: BuilderPath, field: 'id' | 'uses' | 'run' | 'condition' | 'harness' | 'model' | 'prompt', value: string): string {
  return edit(text, (doc) => {
    const node = doc.getIn(path, true);
    if (!isMap(node)) return;
    if (field === 'harness' || field === 'model' || field === 'prompt') return setWith(doc, node, field, value);
    const key = field === 'condition' ? 'if' : field;
    if (value === '' && key !== 'id') node.delete(key);
    else node.set(key, key === 'if' ? `\${{ ${value.trim()} }}` : value);
  });
}

function setWith(doc: Document, step: YAMLMap, key: string, value: string): void {
  const w = step.get('with', true);
  if (value === '') {
    if (!isMap(w)) return;
    w.delete(key);
    if (w.items.length === 0) step.delete('with');
    return;
  }
  if (isMap(w)) w.set(key, value);
  else step.set('with', doc.createNode({ [key]: value }));
}

export function setAttemptsMax(text: string, path: BuilderPath, value: string): string {
  return edit(text, (doc) => {
    const body = doc.getIn([...path, 'attempts'], true);
    if (!isMap(body)) return;
    const trimmed = value.trim();
    body.set('max', /^\d+$/.test(trimmed) ? Number(trimmed) : value);
  });
}
