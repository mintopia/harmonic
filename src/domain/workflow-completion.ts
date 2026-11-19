import { WORKFLOW_ACTIONS } from './workflow.js';

export interface WorkflowCompletionOption {
  label: string;
  detail: string;
}

export interface CompletionModelOption {
  id: string;
  harness: string;
  model: string;
  description: string;
}

export interface WorkflowCompletion {
  from: number;
  options: WorkflowCompletionOption[];
}

const ACTION_DETAIL: Record<(typeof WORKFLOW_ACTIONS)[number], string> = {
  rebase: 'rebase the branch onto its base',
  agent: 'run a Harness on a prompt',
  verify: 'marker step that always passes',
  command: 'shell verify command',
  critic: 'Harness, Model, prompt',
  merge: 'merge the branch into its base',
  'open-pr': 'open a pull request',
  artifact: 'collect a build artifact',
  'post-merge-check': 'check the base after the merge',
  'close-ticket': 'close the tracker issue',
  comment: 'post to the tracker',
  cleanup: 'remove worktree and branch',
};

const ACTION_ORDER: readonly (typeof WORKFLOW_ACTIONS)[number][] = ['command', 'critic', 'comment', 'cleanup', 'close-ticket'];
const actionRank = (a: string): number => {
  const i = (ACTION_ORDER as readonly string[]).indexOf(a);
  return i === -1 ? ACTION_ORDER.length : i;
};

const STEP_KEYS: WorkflowCompletionOption[] = [
  { label: 'id', detail: 'unique step name' },
  { label: 'uses', detail: 'a Workflow Action' },
  { label: 'with', detail: 'inputs for the action' },
  { label: 'if', detail: 'run only when the condition holds' },
  { label: 'run', detail: 'shell command to run' },
  { label: 'runs_on', detail: 'Execution Target for this step' },
  { label: 'image', detail: 'container image for this step' },
  { label: 'parallel', detail: 'steps that run side by side' },
];

const TOP_KEYS: WorkflowCompletionOption[] = [
  { label: 'name', detail: 'workflow name' },
  { label: 'description', detail: 'what the workflow is for' },
  { label: 'runs_on', detail: 'default Execution Target for the steps' },
  { label: 'image', detail: 'default container image for the steps' },
  { label: 'vars', detail: 'values steps read as vars.NAME' },
  { label: 'steps', detail: 'the steps, in order' },
  { label: 'cleanup', detail: 'steps that always run last' },
];

const ATTEMPTS_KEYS: WorkflowCompletionOption[] = [
  { label: 'max', detail: 'attempts allowed, 1 to 20' },
  { label: 'steps', detail: 'steps repeated each attempt' },
];

const WITH_KEYS: WorkflowCompletionOption[] = [
  { label: 'prompt', detail: 'the prompt text' },
  { label: 'option', detail: 'a Model Option code, instead of harness and model' },
  { label: 'harness', detail: 'which Harness runs it' },
  { label: 'model', detail: 'which Model to use' },
  { label: 'continueAttempts', detail: 'how many times to continue' },
  { label: 'continuePrompt', detail: 'prompt for each continuation' },
];

const KEY_LINE = /^(\s*)((?:-[ \t]+)*)([A-Za-z][\w-]*)?$/;
const USES_LINE = /^\s*(?:-[ \t]+)*uses:[ \t]*([\w-]*)$/;
const OPTION_LINE = /^(\s*)((?:-[ \t]+)*)option:[ \t]*([\w-]*)$/;
const KEYED = /^(\s*)((?:-[ \t]+)*)([A-Za-z][\w-]*):/;

interface KeyedLine {
  col: number;
  key: string;
  index: number;
}

function keyed(lines: string[], index: number): KeyedLine | null {
  const m = KEYED.exec(lines[index]!);
  return m ? { col: m[1]!.length + m[2]!.length, key: m[3]!, index } : null;
}

function parentOf(lines: string[], from: number, col: number): KeyedLine | null {
  for (let i = from - 1; i >= 0; i--) {
    const k = keyed(lines, i);
    if (k && k.col < col) return k;
  }
  return null;
}

function stepUses(lines: string[], withLine: KeyedLine): string | undefined {
  const read = (i: number): string | undefined => /uses:[ \t]*([\w-]+)/.exec(lines[i]!)?.[1];
  for (const step of [-1, 1]) {
    for (let i = withLine.index + step; i >= 0 && i < lines.length; i += step) {
      const k = keyed(lines, i);
      if (!k) continue;
      if (k.col < withLine.col) break;
      const startsItem = /^\s*-/.test(lines[i]!);
      if (k.col === withLine.col && startsItem && step > 0) break;
      if (k.col === withLine.col && k.key === 'uses') return read(i);
      if (k.col === withLine.col && startsItem) break;
    }
  }
  return undefined;
}

const prefixed = (options: WorkflowCompletionOption[], typed: string): WorkflowCompletionOption[] => options.filter((o) => o.label.startsWith(typed) && o.label !== typed);

const offered = (offset: number, typed: string, options: WorkflowCompletionOption[]): WorkflowCompletion | null =>
  options.length ? { from: offset - typed.length, options } : null;

const isAgentic = (action: string | undefined): boolean => action === 'agent' || action === 'critic';

const STEP_LIST_PARENTS: ReadonlySet<string> = new Set(['steps', 'cleanup', 'parallel']);

function keyPool(lines: string[], parent: KeyedLine | null, col: number, inListItem: boolean): WorkflowCompletionOption[] {
  if (!parent) return col === 0 ? TOP_KEYS : [];
  if (STEP_LIST_PARENTS.has(parent.key)) {
    const topLevelSteps = parent.key === 'steps' && parentOf(lines, parent.index, parent.col) === null;
    return topLevelSteps && inListItem ? [...STEP_KEYS, { label: 'attempts', detail: 'retry the enclosed steps' }] : STEP_KEYS;
  }
  if (parent.key === 'attempts') return ATTEMPTS_KEYS;
  if (parent.key === 'with') return isAgentic(stepUses(lines, parent)) ? WITH_KEYS : [];
  return [];
}

/** Never throws: indentation-based, so half-typed YAML still completes. */
export function completeWorkflow(text: string, offset: number, modelOptions: readonly CompletionModelOption[] = []): WorkflowCompletion | null {
  if (offset < 0 || offset > text.length) return null;
  const lines = text.split('\n');
  const before = text.slice(0, offset);
  const lineIndex = before.split('\n').length - 1;
  const upToCursor = before.slice(before.lastIndexOf('\n') + 1);

  const uses = USES_LINE.exec(upToCursor);
  if (uses) {
    const typed = uses[1]!;
    const options = [...WORKFLOW_ACTIONS].sort((a, b) => actionRank(a) - actionRank(b)).filter((a) => a.startsWith(typed) && a !== typed).map((label) => ({ label, detail: ACTION_DETAIL[label] }));
    return offered(offset, typed, options);
  }

  const option = OPTION_LINE.exec(upToCursor);
  if (option) {
    const typed = option[3]!;
    const parent = parentOf(lines, lineIndex, option[1]!.length + option[2]!.length);
    const action = parent?.key === 'with' ? stepUses(lines, parent) : undefined;
    if (!isAgentic(action)) return null;
    const options = modelOptions.filter((o) => o.id.startsWith(typed) && o.id !== typed).map((o) => ({ label: o.id, detail: `${o.harness} · ${o.model} · ${o.description}` }));
    return offered(offset, typed, options);
  }

  const key = KEY_LINE.exec(upToCursor);
  if (!key) return null;
  const typed = key[3] ?? '';
  const col = key[1]!.length + key[2]!.length;
  const pool = keyPool(lines, parentOf(lines, lineIndex, col), col, key[2]!.length > 0);
  return offered(offset, typed, prefixed(pool, typed));
}
