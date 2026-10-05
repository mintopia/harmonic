import { CRITIC_FRAGMENT_NAMES, PROMPT_FRAGMENT_NAMES, type CriticFragments, type PromptFragments } from '../src/domain/prompt-fragments.js';

export const blankPromptFragments = (): PromptFragments & CriticFragments =>
  Object.fromEntries([...PROMPT_FRAGMENT_NAMES, ...CRITIC_FRAGMENT_NAMES].map((name) => [name, ''])) as PromptFragments & CriticFragments;
