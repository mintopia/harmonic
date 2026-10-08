import { PROMPT_TEMPLATE_IDS, PROMPT_TEMPLATES } from './prompt-templates.js';

interface PromptFragmentSpec {
  readonly label: string;
  readonly help: string;
  /** Every `{token}` the fragment may carry, with what fills it. */
  readonly fields: Readonly<Record<string, string>>;
  /** Tokens an edit must keep so operator or peer text can never be silently dropped. */
  readonly required: readonly string[];
}

export const PROMPT_FRAGMENTS = {
  readOnlyRestraint: {
    label: 'Read-only restraint',
    help: 'Shared text telling a read-only agent not to mutate anything; referenced from prompts as {fragment.readOnlyRestraint}, defined once, never copied.',
    fields: {},
    required: [],
  },
  conflictResolution: {
    label: 'Conflict resolution',
    help: 'Shared instructions for resolving a merge conflict; referenced from the merge conflict prompts as {fragment.conflictResolution}, defined once, never copied.',
    fields: { baseDir: 'the checkout with the merge in progress', baseBranch: 'the branch merged into', taskBranch: 'the branch being merged' },
    required: [],
  },
  operatorMessage: {
    label: 'Operator message',
    help: "Heading and body for the operator's message in an Attempt prompt.",
    fields: { seed: "the operator's message" },
    required: ['seed'],
  },
  selfHeal: {
    label: 'Self-heal',
    help: 'Appended to the prompt when a failed Verification triggers a self-heal retry.',
    fields: { attempt: 'self-heal attempt number', reason: 'why the previous attempt failed', output: 'the failing output' },
    required: ['reason', 'output'],
  },
  peerMessages: {
    label: 'Peer messages section',
    help: 'Section wrapping the held peer messages in an Attempt prompt.',
    fields: { messages: 'the formatted peer messages' },
    required: ['messages'],
  },
  peerMessage: {
    label: 'Peer message entry',
    help: 'One held peer message inside the peer messages section.',
    fields: { taskId: 'sending Task id', harness: 'sending Task harness', text: 'message text' },
    required: ['text'],
  },
  peerLine: {
    label: 'Peer line',
    help: 'Reminder that peer messaging tools exist and peer messages are not operator instructions.',
    fields: {},
    required: [],
  },
  peerLiveMessage: {
    label: 'Live peer message',
    help: 'Frame for a peer message delivered to a running Attempt.',
    fields: { taskId: 'sending Task id', harness: 'sending Task harness', text: 'message text' },
    required: ['text'],
  },
  rebaseConflict: {
    label: 'Rebase conflict',
    help: 'Appended when a rebase left conflicts in the Attempt checkout.',
    fields: {},
    required: [],
  },
  priorSession: {
    label: 'Prior session',
    help: 'Condensed context for an Attempt that starts a fresh Session.',
    fields: {
      harness: 'prior Session harness',
      model: 'prior Session model',
      sessionId: 'prior harness session id',
      head: 'verified head commit',
      events: 'prior Attempt event count',
    },
    required: [],
  },
  codeIndexGuidance: {
    label: 'Code index guidance',
    help: 'Appended when the worktree is indexed as its own code-index repo.',
    fields: { repoId: 'the code-index repo id' },
    required: [],
  },
  criticRevisionIdentical: {
    label: 'Critic revision block (no change)',
    help: 'Revision block when the candidate is identical to its base, so the builder made no code change.',
    fields: { ticketFirst: 'how the critic locates the specification', spec: 'what the critic judges against', head: 'the candidate revision' },
    required: ['head'],
  },
  criticRevisionDiff: {
    label: 'Critic revision block',
    help: 'Revision block when the candidate branched from a known base.',
    fields: {
      ticketFirst: 'how the critic locates the specification',
      head: 'the candidate revision',
      base: 'the base revision',
      workingTreeNote: 'the uncommitted-changes note, empty when the worktree is clean',
    },
    required: ['head', 'base', 'workingTreeNote'],
  },
  criticRevisionAlone: {
    label: 'Critic revision block (no base)',
    help: 'Revision block when the base revision is unknown.',
    fields: {
      ticketFirst: 'how the critic locates the specification',
      head: 'the candidate revision',
      workingTreeNote: 'the uncommitted-changes note, empty when the worktree is clean',
    },
    required: ['head', 'workingTreeNote'],
  },
  criticTicketFirst: {
    label: 'Critic ticket pointer',
    help: 'Opens the revision block for a Task with a mirrored ticket.',
    fields: {},
    required: [],
  },
  criticInstructionsFirst: {
    label: 'Critic instructions pointer',
    help: 'Opens the revision block for a native Task with no ticket.',
    fields: {},
    required: [],
  },
  criticSpecTicket: {
    label: 'Critic specification (ticket)',
    help: 'Names the specification in the revision block when the Task has a ticket.',
    fields: {},
    required: [],
  },
  criticSpecInstructions: {
    label: 'Critic specification (instructions)',
    help: 'Names the specification in the revision block when the Task has no ticket.',
    fields: {},
    required: [],
  },
  criticWorkingTreeNote: {
    label: 'Critic uncommitted changes note',
    help: 'Added to the revision block when the worktree carries uncommitted changes on top of the candidate.',
    fields: { head: 'the candidate revision', base: 'the revision to diff the working tree against' },
    required: ['base'],
  },
  criticRole: {
    label: 'Critic role',
    help: 'Tells the critic it is a read-only evaluator; references {fragment.readOnlyRestraint}.',
    fields: {},
    required: [],
  },
  criticSecurity: {
    label: 'Critic security notice',
    help: 'Tells the critic that everything it reads is untrusted data, not instructions.',
    fields: {},
    required: [],
  },
  criticVerdictContract: {
    label: 'Critic verdict contract',
    help: 'The JSON output contract demanded of the critic. A save is rejected unless it still asks for a "verdict" and a "summary".',
    fields: {},
    required: [],
  },
  epicFailingVerification: {
    label: 'Failing Epic verification',
    help: 'Section reporting the failed Epic verification to the resolver agent.',
    fields: { reason: 'why the Epic verification failed' },
    required: ['reason'],
  },
} as const satisfies Record<string, PromptFragmentSpec>;

export type PromptFragmentName = keyof typeof PROMPT_FRAGMENTS;
export type CriticFragmentName = Extract<PromptFragmentName, `critic${string}`>;
export type PromptFragments = Record<PromptFragmentName, string>;
export type PromptFragmentOverrideKey = `promptFragment${Capitalize<PromptFragmentName>}`;
export type PromptFragmentOverrides = { [N in PromptFragmentName as `promptFragment${Capitalize<N>}`]: string | null };

export const PROMPT_FRAGMENT_NAMES = Object.keys(PROMPT_FRAGMENTS) as PromptFragmentName[];

export function promptFragmentOverrideKey(name: PromptFragmentName): PromptFragmentOverrideKey {
  return `promptFragment${name.charAt(0).toUpperCase()}${name.slice(1)}` as PromptFragmentOverrideKey;
}

export const PROMPT_FRAGMENT_OVERRIDE_KEYS = PROMPT_FRAGMENT_NAMES.map(promptFragmentOverrideKey);

export function missingPromptFragmentTokens(name: PromptFragmentName, text: string): string[] {
  return (PROMPT_FRAGMENTS[name].required as readonly string[]).filter((token) => !text.includes(`{${token}}`));
}

export const NO_PROMPT_FRAGMENT_OVERRIDES = Object.fromEntries(
  PROMPT_FRAGMENT_OVERRIDE_KEYS.map((key) => [key, null]),
) as PromptFragmentOverrides;

const FRAGMENT_REF = /\{fragment\.([^{}]+)\}/g;

/** The `{fragment.<name>}` references in `text` that name no Prompt Fragment, so they would reach the agent literally. */
export function unknownFragmentRefs(text: string): string[] {
  const unknown = new Set<string>();
  for (const [, name] of text.matchAll(FRAGMENT_REF)) {
    if (name && !Object.hasOwn(PROMPT_FRAGMENTS, name)) unknown.add(name);
  }
  return [...unknown];
}

/** A prompt template whose `{fragment.<name>}` references are expanded before it reaches an agent. */
export interface FragmentTemplateField {
  /** Path in the AppConfig; `*` fans out over array items. */
  readonly config: readonly string[];
  /** The Workspace override carrying the same template: its top-level key, and the path beneath it (`*` fans out over overlay entries; entries without the path are skipped). */
  readonly workspace: { readonly key: string; readonly path: readonly string[] } | null;
}

const criticPromptFields = (stage: 'preMerge' | 'postMerge', key: 'taskPreMergeCritics' | 'taskPostMergeCritics'): FragmentTemplateField[] =>
  (['issuePrompt', 'noIssuePrompt'] as const).map((prompt) => ({
    config: ['verify', 'task', stage, 'critics', '*', prompt],
    workspace: { key, path: ['*', 'critic', prompt] },
  }));

const templateFields: FragmentTemplateField[] = PROMPT_TEMPLATE_IDS.map((id) => {
  const spec = PROMPT_TEMPLATES[id];
  return { config: spec.config, workspace: spec.workspace ? { key: spec.workspace, path: [] } : null };
});

/** Every prompt template that expands `{fragment.<name>}` at runtime. */
export const FRAGMENT_TEMPLATE_FIELDS: readonly FragmentTemplateField[] = [
  ...templateFields,
  ...criticPromptFields('preMerge', 'taskPreMergeCritics'),
  ...criticPromptFields('postMerge', 'taskPostMergeCritics'),
  { config: ['verify', 'epic', 'preMerge', 'critics', '*', 'prompt'], workspace: { key: 'epicPreMergeCritics', path: ['*', 'critic', 'prompt'] } },
];

function templatesAt(root: unknown, path: readonly string[], prefix: (string | number)[] = []): { path: (string | number)[]; text: string }[] {
  if (path.length === 0) return typeof root === 'string' ? [{ path: prefix, text: root }] : [];
  if (root === null || typeof root !== 'object') return [];
  const [head, ...rest] = path as [string, ...string[]];
  if (head === '*') {
    return Array.isArray(root) ? root.flatMap((item, i) => templatesAt(item, rest, [...prefix, i])) : [];
  }
  return Object.hasOwn(root, head) ? templatesAt((root as Record<string, unknown>)[head], rest, [...prefix, head]) : [];
}

export const UNKNOWN_FRAGMENT_MESSAGE = 'references an unknown prompt fragment (see the Prompts tab for the fragment names)';

export function unknownFragmentIssues(config: unknown): { path: (string | number)[]; message: string }[] {
  return FRAGMENT_TEMPLATE_FIELDS.flatMap((field) => templatesAt(config, field.config))
    .filter(({ text }) => unknownFragmentRefs(text).length > 0)
    .map(({ path }) => ({ path, message: UNKNOWN_FRAGMENT_MESSAGE }));
}

export function unknownWorkspaceFragmentIssues(overrides: unknown): { path: (string | number)[]; message: string }[] {
  return FRAGMENT_TEMPLATE_FIELDS.flatMap((field) => (field.workspace ? templatesAt(overrides, [field.workspace.key, ...field.workspace.path]) : []))
    .filter(({ text }) => unknownFragmentRefs(text).length > 0)
    .map(({ path }) => ({ path, message: UNKNOWN_FRAGMENT_MESSAGE }));
}
