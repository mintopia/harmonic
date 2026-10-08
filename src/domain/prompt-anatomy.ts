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

const template = (id: PromptTemplateId, rest: Omit<AnatomyPart, 'kind' | 'key'> = {}): AnatomyPart => ({ kind: 'part', key: templateKey(id), ...rest });
const fragment = (name: PromptFragmentName, rest: Omit<AnatomyPart, 'kind' | 'key'> = {}): AnatomyPart => ({ kind: 'part', key: `fragment:${name}`, ...rest });

const ticketFirst: AnatomyChoice = {
  kind: 'oneOf',
  by: 'ticket',
  label: 'One of, by whether the Task has a ticket',
  options: [
    { value: 'ticket', label: 'Ticket', when: 'when the Task has a mirrored ticket', parts: [fragment('criticTicketFirst')] },
    { value: 'instructions', label: 'No ticket', when: 'when the Task is native, with no ticket', parts: [fragment('criticInstructionsFirst')] },
  ],
};

const criticSpec: AnatomyChoice = {
  kind: 'oneOf',
  by: 'ticket',
  label: 'One of, by whether the Task has a ticket',
  options: [
    { value: 'ticket', label: 'Ticket', when: 'when the Task has a mirrored ticket', parts: [fragment('criticSpecTicket')] },
    { value: 'instructions', label: 'No ticket', when: 'when the Task is native, with no ticket', parts: [fragment('criticSpecInstructions')] },
  ],
};

const workingTreeNote = fragment('criticWorkingTreeNote', { when: 'dirtyWorktree', via: 'slot' });

export const PROMPT_ANATOMIES: readonly PromptAnatomy[] = [
  {
    id: 'implementation',
    title: 'Implementation turn',
    description: 'What the agent receives when an Attempt starts a turn, in the order it is sent.',
    flags: [
      { id: 'selfHeal', label: 'when the previous Attempt failed Verification', toggle: 'Previous Attempt failed Verification', sample: false },
      { id: 'operatorSeeded', label: 'when the operator seeded this turn', toggle: 'Operator message', sample: false },
      { id: 'heldPeerMessages', label: 'when peer messages are held for this Task', toggle: 'Held peer messages', sample: false },
      { id: 'agentMessages', label: 'when Agent Messages are on', toggle: 'Agent Messages on', sample: true },
      { id: 'rebaseConflict', label: 'when a rebase left conflicts in the Attempt checkout', toggle: 'Rebase conflict', sample: false },
      { id: 'priorSession', label: 'when the Attempt starts a fresh Session from a prior one', toggle: 'Prior session context', sample: false },
      { id: 'codeIndex', label: 'when the worktree is indexed as its own code-index repo', toggle: 'Worktree code index', sample: true },
    ],
    selectorDefaults: { origin: 'native' },
    parts: [
      {
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
      },
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
      {
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
      },
    ],
  },
  {
    id: 'mergeConflicts',
    title: 'Merge conflicts',
    description: 'What the agent that resolves a conflict receives, by resolver.',
    flags: [],
    selectorDefaults: { resolver: 'task' },
    parts: [
      {
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
      },
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
    flags: [{ id: 'dirtyWorktree', label: 'when the worktree has uncommitted changes', toggle: 'Uncommitted changes', sample: false }],
    selectorDefaults: { revision: 'diff', ticket: 'ticket' },
    parts: [
      { kind: 'part', key: 'criticPrompt', note: "Each critic's own prompt, set per critic on the Verification tab." },
      {
        kind: 'oneOf',
        by: 'revision',
        label: 'One of, by what the candidate is compared with',
        options: [
          {
            value: 'diff',
            label: 'Known base',
            when: 'when the candidate branched from a known base',
            parts: [fragment('criticRevisionDiff', { nested: [ticketFirst, workingTreeNote] })],
          },
          {
            value: 'identical',
            label: 'No change',
            when: 'when the candidate is identical to its base',
            parts: [fragment('criticRevisionIdentical', { nested: [ticketFirst, criticSpec] })],
          },
          {
            value: 'alone',
            label: 'No base',
            when: 'when the base revision is unknown',
            parts: [fragment('criticRevisionAlone', { nested: [ticketFirst, workingTreeNote] })],
          },
        ],
      },
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

function topLevelKeys(nodes: readonly AnatomyNode[], sel: Readonly<Record<string, string>>, into: PartKey[]): void {
  for (const node of nodes) {
    if (node.kind === 'part') {
      into.push(node.key);
      continue;
    }
    const chosen = node.options.find((option) => option.value === sel[node.by]) ?? node.options[0];
    if (chosen) topLevelKeys(chosen.parts, sel, into);
  }
}

export function topLevelOrder(a: PromptAnatomy, sel: Readonly<Record<string, string>>): PartKey[] {
  const keys: PartKey[] = [];
  topLevelKeys(a.parts, { ...a.selectorDefaults, ...sel }, keys);
  return keys;
}

export function partAnatomies(key: PartKey): AnatomyId[] {
  return PROMPT_ANATOMIES.filter((a) => anatomyPartKeys(a).includes(key)).map((a) => a.id);
}

const PART_TEXT = new Map<PartKey, { label: string; help: string }>([
  ['criticPrompt', { label: 'Critic prompt', help: "Each critic's own prompt, set per critic on the Verification tab." }],
  ...PROMPT_TEMPLATE_IDS.map((id): [PartKey, { label: string; help: string }] => [templateKey(id), PROMPT_TEMPLATES[id]]),
  ...PROMPT_FRAGMENT_NAMES.map((name): [PartKey, { label: string; help: string }] => [`fragment:${name}`, PROMPT_FRAGMENTS[name]]),
]);

export const partLabel = (key: PartKey): string => PART_TEXT.get(key)?.label ?? key;
export const partHelp = (key: PartKey): string => PART_TEXT.get(key)?.help ?? '';
