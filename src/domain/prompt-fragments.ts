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
} as const satisfies Record<string, PromptFragmentSpec>;

export const CRITIC_FRAGMENT_NAMES = ['criticRevisionIdentical', 'criticRevisionDiff', 'criticRevisionAlone', 'criticVerdictContract'] as const;
export type CriticFragmentName = (typeof CRITIC_FRAGMENT_NAMES)[number];
export type CriticFragments = Record<CriticFragmentName, string>;

export type PromptFragmentName = keyof typeof PROMPT_FRAGMENTS;
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
