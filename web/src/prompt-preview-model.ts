import type { EnginePrompts } from '../../src/domain/bundled-prompts.js';
import type { ClassifierInput } from '../../src/domain/route-classifier.js';
import { buildCriticPrompt, renderAgentPrompt } from '../../src/execution/prompt-assembly.js';
import type { DriveFields } from '../../src/execution/prompt-template.js';

/** Illustrative values for the `{taskId}/{skill}/{ref}/{url}/{title}/{description}` tokens. */
export const SAMPLE_DRIVE_FIELDS: DriveFields = {
  taskId: '172',
  skill: '/implement',
  ref: '123',
  url: 'https://github.com/acme/repo/issues/123',
  title: 'Example issue title',
  description: 'Example issue body describing the change to make.',
};

/** Illustrative values for every `{field}` a workflow agent or critic step fills. */
export const SAMPLE_STEP_FIELDS: Readonly<Record<string, string | number>> = {
  ...SAMPLE_DRIVE_FIELDS,
  prompt: SAMPLE_DRIVE_FIELDS.description,
  id: SAMPLE_DRIVE_FIELDS.taskId,
  workingDir: '/workspace/repo',
  harness: 'claude',
  model: 'sonnet',
  branch: 'epic/example',
  feedback: '',
  attempt: 0,
  reason: '',
  output: '',
};

const SAMPLE_TICKET = { title: SAMPLE_DRIVE_FIELDS.title, body: SAMPLE_DRIVE_FIELDS.description, labels: ['bug'], ref: SAMPLE_DRIVE_FIELDS.ref, origin: 'mirrored' };

/** The text as a step would send it, filled with sample values; a malformed expression leaves it as written. */
export function fillSample(text: string): string {
  const vars = Object.fromEntries([...text.matchAll(/\bvars\.([A-Za-z_][\w-]*)/g)].map(([, name]) => [name as string, `<${name}>`]));
  try {
    return renderAgentPrompt(text, SAMPLE_STEP_FIELDS, { ticket: SAMPLE_TICKET, vars });
  } catch {
    return text;
  }
}

/** A compiled prompt shown under one editor, optionally split into labeled
 * variants that render side by side. */
export interface LabeledPreview {
  label: string;
  text: string;
}

const SAMPLE_VERIFIED_HEAD_OID = 'ec5ed1f1edead000000000000000000000000000';
const SAMPLE_BASE_OID = 'ba5e0000000000000000000000000000000000000';

/** One interpolation token a prompt editor offers. `core` tokens — the Task's own
 * identity (`{taskId}`, `{title}`, `{description}`) — are always available on a
 * surface and are grouped first; the rest are context tokens that depend on the
 * surface (a ticket ref, the running harness). */
export type Placeholder = { token: string; desc: string; core?: boolean };

/** The Task-identity tokens every review surface resolves, ticket or not. */
const CORE_TASK: Placeholder[] = [
  { token: '{taskId}', desc: 'Harmonic task id', core: true },
  { token: '{title}', desc: 'task title', core: true },
  { token: '{description}', desc: 'task description', core: true },
];

const SKILL_PLACEHOLDER: Placeholder = { token: '{skill}', desc: 'workflow skill — /research or /implement' };

export const DRIVE_PLACEHOLDERS: Placeholder[] = [
  ...CORE_TASK,
  SKILL_PLACEHOLDER,
  { token: '{ref}', desc: 'issue number' },
  { token: '{url}', desc: 'issue URL' },
];

export function compileEpicCriticPreview(prompt: string, prompts: EnginePrompts): string {
  return buildCriticPrompt({
    operatorPrompt: prompt,
    fields: SAMPLE_DRIVE_FIELDS,
    verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
    baseOid: SAMPLE_BASE_OID,
    prompts,
  });
}

export const SAMPLE_CLASSIFIER_INPUT: ClassifierInput = {
  title: SAMPLE_DRIVE_FIELDS.title,
  description: SAMPLE_DRIVE_FIELDS.description,
  labels: ['bug'],
  attemptNumber: 1,
  options: [
    { id: 'quick-fix', description: 'Small, well-scoped changes', harness: 'claude', model: 'sonnet' },
    { id: 'deep-work', description: 'Large or ambiguous changes', harness: 'claude', model: 'opus' },
  ],
};
