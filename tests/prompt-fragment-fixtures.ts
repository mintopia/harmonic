import { PROMPT_FRAGMENT_NAMES, type PromptFragments } from '../src/domain/prompt-fragments.js';

export const blankPromptFragments = (): PromptFragments => Object.fromEntries(PROMPT_FRAGMENT_NAMES.map((name) => [name, ''])) as PromptFragments;
