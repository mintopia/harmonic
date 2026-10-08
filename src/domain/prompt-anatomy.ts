import { PROMPT_FRAGMENT_NAMES, PROMPT_FRAGMENTS, type PromptFragmentName } from './prompt-fragments.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS, type PromptTemplateId } from './prompt-templates.js';

export type PartKey = `template:${PromptTemplateId}` | `fragment:${PromptFragmentName}` | 'criticPrompt';

export interface AnatomyPart {
  readonly kind: 'part';
  readonly key: PartKey;
  /** Flag id; absent means always included. */
  readonly when?: string;
  readonly note?: string;
  readonly nested?: readonly AnatomyNode[];
  /** Nested only: `slot` = code fills a `{token}` in the parent; `reference` = `{fragment.x}` in the parent's default text. */
  readonly via?: 'slot' | 'reference';
}

export interface AnatomyOption {
  readonly value: string;
  readonly label: string;
  readonly when: string;
  readonly parts: readonly AnatomyNode[];
}

export interface AnatomyChoice {
  readonly kind: 'oneOf';
  readonly by: string;
  readonly label: string;
  readonly options: readonly AnatomyOption[];
}

export type AnatomyNode = AnatomyPart | AnatomyChoice;

export type AnatomyId = 'implementation' | 'nudges' | 'mergeConflicts' | 'epicFix' | 'criticReview';

export interface AnatomyFlag {
  readonly id: string;
  /** Condition copy shown on the part: "when the previous Attempt failed Verification". */
  readonly label: string;
  /** Switch label in the sample conditions. */
  readonly toggle: string;
  /** Whether the sample preview starts with the flag on. */
  readonly sample: boolean;
}

export interface PromptAnatomy {
  readonly id: AnatomyId;
  readonly title: string;
  readonly description: string;
  readonly flags: readonly AnatomyFlag[];
  readonly selectorDefaults: Readonly<Record<string, string>>;
  readonly parts: readonly AnatomyNode[];
}

export const templateKey = (id: PromptTemplateId): PartKey => `template:${id}`;
export const fragmentKey = (name: PromptFragmentName): PartKey => `fragment:${name}`;

const template = (id: PromptTemplateId, rest: Omit<AnatomyPart, 'kind' | 'key'> = {}): AnatomyPart => ({ kind: 'part', key: templateKey(id), ...rest });
const fragment = (name: PromptFragmentName, rest: Omit<AnatomyPart, 'kind' | 'key'> = {}): AnatomyPart => ({ kind: 'part', key: fragmentKey(name), ...rest });

const ticketChoice = (ticket: PromptFragmentName, instructions: PromptFragmentName) =>
  ({
    kind: 'oneOf',
    by: 'ticket',
    label: 'One of, by whether the Task has a ticket',
    options: [
      { value: 'ticket', label: 'Ticket', when: 'when the Task has a mirrored ticket', parts: [fragment(ticket)] },
      { value: 'instructions', label: 'No ticket', when: 'when the Task is native, with no ticket', parts: [fragment(instructions)] },
    ],
  }) as const satisfies AnatomyChoice;

export const TICKET = ticketChoice('criticTicketFirst', 'criticInstructionsFirst');
const criticSpec = ticketChoice('criticSpecTicket', 'criticSpecInstructions');

const workingTreeNote = fragment('criticWorkingTreeNote', { when: 'dirtyWorktree', via: 'slot' });

const IMPLEMENTATION_FLAGS = [
  { id: 'feedback', label: 'when the previous Attempt left feedback', toggle: 'Previous Attempt feedback', sample: false },
  { id: 'selfHeal', label: 'when the previous Attempt failed Verification', toggle: 'Previous Attempt failed Verification', sample: false },
  { id: 'operatorSeeded', label: 'when the operator seeded this turn', toggle: 'Operator message', sample: false },
  { id: 'heldPeerMessages', label: 'when peer messages are held for this Task', toggle: 'Held peer messages', sample: false },
  { id: 'agentMessages', label: 'when Agent Messages are on', toggle: 'Agent Messages on', sample: true },
  { id: 'rebaseConflict', label: 'when a rebase left conflicts in the Attempt checkout', toggle: 'Rebase conflict', sample: false },
  { id: 'priorSession', label: 'when the Attempt starts a fresh Session from a prior one', toggle: 'Prior session context', sample: false },
  { id: 'codeIndex', label: 'when the worktree is indexed as its own code-index repo', toggle: 'Worktree code index', sample: true },
] as const satisfies readonly AnatomyFlag[];

export type ImplementationFlagId = (typeof IMPLEMENTATION_FLAGS)[number]['id'];

const CRITIC_FLAGS = [
  { id: 'dirtyWorktree', label: 'when the worktree has uncommitted changes', toggle: 'Uncommitted changes', sample: false },
] as const satisfies readonly AnatomyFlag[];

export type CriticFlagId = (typeof CRITIC_FLAGS)[number]['id'];

export const ORIGIN = {
  kind: 'oneOf',
  by: 'origin',
  label: 'One of, by Task origin',
  options: [
    { value: 'native', label: 'Native', when: 'when the Task is native', parts: [template('taskPrompt')] },
    {
      value: 'mirrored',
      label: 'Mirrored',
      when: 'when the Task is mirrored from a ticket',
      parts: [template('drivePrompt'), template('unattendedReminder')],
    },
  ],
} as const satisfies AnatomyChoice;

export const NUDGE_EVENT = {
  kind: 'oneOf',
  by: 'event',
  label: 'One of, by event',
  options: [
    {
      value: 'continue',
      label: 'Continue',
      when: 'when a turn ends without finishing or escalating',
      parts: [template('continuePrompt'), template('unattendedReminder')],
    },
    { value: 'commit', label: 'Commit', when: 'when a turn ends with uncommitted changes', parts: [template('commitNudge')] },
    { value: 'pause', label: 'Pause', when: 'when the Task is paused', parts: [template('pauseMessage')] },
    { value: 'peer', label: 'Peer message', when: 'when a peer message reaches a running Attempt', parts: [fragment('peerLiveMessage')] },
  ],
} as const satisfies AnatomyChoice;

export const RESOLVER = {
  kind: 'oneOf',
  by: 'resolver',
  label: 'One of, by resolver',
  options: [
    {
      value: 'task',
      label: 'Task merge',
      when: 'when a Task merge conflicts',
      parts: [template('mergeConflictPrompt', { nested: [fragment('conflictResolution', { via: 'reference' })] })],
    },
    {
      value: 'epic',
      label: 'Epic merge',
      when: 'when an Epic integration merge conflicts',
      parts: [template('epicConflictPrompt', { nested: [fragment('conflictResolution', { via: 'reference' })] })],
    },
    {
      value: 'refresh',
      label: 'Epic refresh',
      when: 'when the Epic branch is refreshed from the default branch and conflicts',
      parts: [template('epicRefreshPrompt', { nested: [fragment('conflictResolution', { via: 'reference' })] })],
    },
  ],
} as const satisfies AnatomyChoice;

export const REVISION = {
  kind: 'oneOf',
  by: 'revision',
  label: 'One of, by what the candidate is compared with',
  options: [
    {
      value: 'diff',
      label: 'Known base',
      when: 'when the candidate differs from a known base, or has uncommitted changes on an identical one',
      parts: [fragment('criticRevisionDiff', { nested: [TICKET, workingTreeNote] })],
    },
    {
      value: 'identical',
      label: 'No change',
      when: 'when the candidate is identical to its base and the worktree is clean',
      parts: [fragment('criticRevisionIdentical', { nested: [TICKET, criticSpec] })],
    },
    {
      value: 'alone',
      label: 'No base',
      when: 'when the base revision is unknown',
      parts: [fragment('criticRevisionAlone', { nested: [TICKET, workingTreeNote] })],
    },
  ],
} as const satisfies AnatomyChoice;

export type ChoiceValue<C extends AnatomyChoice> = C['options'][number]['value'];

const isChoiceValue = <C extends AnatomyChoice>(choice: C, raw: string): raw is ChoiceValue<C> => choice.options.some((option) => option.value === raw);

/** Narrows a stored selector value to the choice's declared options, falling back when it is absent or stale. */
export const selectOption = <C extends AnatomyChoice>(choice: C, raw: string | undefined, fallback: ChoiceValue<C>): ChoiceValue<C> =>
  raw !== undefined && isChoiceValue(choice, raw) ? raw : fallback;

export const PROMPT_ANATOMIES: readonly PromptAnatomy[] = [
  {
    id: 'implementation',
    title: 'Implementation turn',
    description: 'What the agent receives when an Attempt starts a turn, in the order it is sent. Feedback from the previous Attempt, when there is any, is appended to the opening.',
    flags: IMPLEMENTATION_FLAGS,
    selectorDefaults: { origin: 'native' },
    parts: [
      ORIGIN,
      fragment('selfHeal', {
        when: 'selfHeal',
      }),
      fragment('operatorMessage', {
        when: 'operatorSeeded',
        note: 'A steer into an already-open Attempt replaces the whole prompt with this message; a fresh Session replaces the opening with the prior-session context.',
      }),
      fragment('peerMessages', { when: 'heldPeerMessages', nested: [fragment('peerMessage', { via: 'slot' })] }),
      fragment('peerLine', { when: 'agentMessages' }),
      fragment('rebaseConflict', { when: 'rebaseConflict' }),
      fragment('priorSession', { when: 'priorSession' }),
      fragment('codeIndexGuidance', { when: 'codeIndex' }),
    ],
  },
  {
    id: 'nudges',
    title: 'Nudges mid-Attempt',
    description: 'Messages sent to a running Attempt between turns, one per event.',
    flags: [],
    selectorDefaults: { event: 'continue' },
    parts: [
      NUDGE_EVENT,
    ],
  },
  {
    id: 'mergeConflicts',
    title: 'Merge conflicts',
    description: 'What the agent that resolves a conflict receives, by resolver.',
    flags: [],
    selectorDefaults: { resolver: 'task' },
    parts: [
      RESOLVER,
    ],
  },
  {
    id: 'epicFix',
    title: 'Epic verification fix',
    description: 'What the agent receives when it fixes a failing Epic verification.',
    flags: [],
    selectorDefaults: {},
    parts: [template('epicResolvePrompt'), fragment('epicFailingVerification'), template('epicResolveSuffix')],
  },
  {
    id: 'criticReview',
    title: 'Critic review',
    description: 'What a critic receives when it reviews a candidate revision.',
    flags: CRITIC_FLAGS,
    selectorDefaults: { revision: 'diff', ticket: 'ticket' },
    parts: [
      { kind: 'part', key: 'criticPrompt', note: "Each critic's own prompt, set per critic on the Verification tab." },
      REVISION,
      fragment('criticRole', { nested: [fragment('readOnlyRestraint', { via: 'reference' })] }),
      fragment('criticSecurity'),
      fragment('criticVerdictContract'),
    ],
  },
];

function nodeKeys(node: AnatomyNode, into: PartKey[]): void {
  if (node.kind === 'oneOf') {
    for (const option of node.options) for (const part of option.parts) nodeKeys(part, into);
    return;
  }
  into.push(node.key);
  for (const child of node.nested ?? []) nodeKeys(child, into);
}

export function anatomyPartKeys(a: PromptAnatomy): PartKey[] {
  const keys: PartKey[] = [];
  for (const node of a.parts) nodeKeys(node, keys);
  return [...new Set(keys)];
}

export function partAnatomies(key: PartKey): AnatomyId[] {
  return PROMPT_ANATOMIES.filter((a) => anatomyPartKeys(a).includes(key)).map((a) => a.id);
}

const PART_TEXT = new Map<PartKey, { label: string; help: string }>([
  ['criticPrompt', { label: 'Critic prompt', help: "Each critic's own prompt, set per critic on the Verification tab." }],
  ...PROMPT_TEMPLATE_IDS.map((id): [PartKey, { label: string; help: string }] => [templateKey(id), PROMPT_TEMPLATES[id]]),
  ...PROMPT_FRAGMENT_NAMES.map((name): [PartKey, { label: string; help: string }] => [fragmentKey(name), PROMPT_FRAGMENTS[name]]),
]);

export const partLabel = (key: PartKey): string => PART_TEXT.get(key)?.label ?? key;
export const partHelp = (key: PartKey): string => PART_TEXT.get(key)?.help ?? '';
