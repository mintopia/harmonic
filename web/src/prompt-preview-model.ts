import { fillTemplate, type DriveFields } from '../../src/execution/prompt-template.js';
import { buildCriticPrompt } from '../../src/verification/critic-prompt.js';
import type { AppConfig } from './types';

/** Illustrative values for the `{taskId}/{skill}/{ref}/{url}/{title}/{description}` tokens. */
export const SAMPLE_DRIVE_FIELDS: DriveFields = {
  taskId: '172',
  skill: '/implement',
  ref: '123',
  url: 'https://github.com/acme/repo/issues/123',
  title: 'Example issue title',
  description: 'Example issue body describing the change to make.',
};

/** A native (board-authored) Task has no mirrored issue: `ref`/`url` are empty, so
 * `buildCriticPrompt` compiles its no-ticket variant. `taskId`/`title`/`description`
 * still come from the Task itself, so they stay populated. */
export const SAMPLE_NATIVE_DRIVE_FIELDS: DriveFields = {
  ...SAMPLE_DRIVE_FIELDS,
  ref: '',
  url: '',
};

/** A compiled prompt shown under one editor, optionally split into labeled
 * variants that render side by side. */
export interface LabeledPreview {
  label: string;
  text: string;
}

/** Illustrative value for the `{taskId}` token. */
export const SAMPLE_TASK_ID = '123';

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

export const CRITIC_NO_ISSUE_PLACEHOLDERS: Placeholder[] = [...CORE_TASK, SKILL_PLACEHOLDER];

export const EPIC_RESOLVE_PLACEHOLDERS: Placeholder[] = [
  { token: '{title}', desc: 'Epic title', core: true },
  { token: '{description}', desc: 'Epic description', core: true },
  { token: '{ref}', desc: 'Epic issue number' },
  { token: '{url}', desc: 'Epic issue URL' },
];

export const TASK_ID_PLACEHOLDER: Placeholder[] = [{ token: '{taskId}', desc: 'Harmonic task id', core: true }];

export const TASK_PLACEHOLDERS: Placeholder[] = [
  { token: '{prompt}', desc: "the task's own prompt" },
  { token: '{id}', desc: 'task id', core: true },
  { token: '{workingDir}', desc: 'working directory' },
  { token: '{harness}', desc: 'harness id' },
  { token: '{model}', desc: 'model id' },
];

/** Fill the five Drive tokens with the sample values. */
export function compileDrivePreview(template: string): string {
  return fillTemplate(template, SAMPLE_DRIVE_FIELDS);
}

/** Fill the five Task-prompt tokens with sample values. */
export function compileTaskPreview(template: string, config: Pick<AppConfig, 'defaults' | 'harnesses'>): string {
  const harness = config.defaults.harness;
  const selectedHarness = config.harnesses[harness];
  if (!selectedHarness) throw new Error(`Missing configured harness: ${harness}`);
  return fillTemplate(template, {
    prompt: 'Example task prompt.',
    id: 123,
    workingDir: '/repo',
    harness,
    model: selectedHarness.defaultModel,
  });
}

/** Fill the `{taskId}` token with the sample value. */
export function compileTaskIdPreview(template: string): string {
  return template.replace(/\{taskId\}/g, SAMPLE_TASK_ID);
}

/** Compile the critic review prompt exactly as `runCritic` would: the operator
 * note interpolated, plus the appended revision block, restraint instruction, and
 * JSON-verdict scaffolding. Sample revisions stand in for a live Task's. The same
 * operator prompt compiles differently per Task kind, so both variants are shown:
 * a mirrored Task judged against its ticket, and a native Task judged against the
 * instructions alone. */
export function compileCriticPreview(prompts: { issuePrompt: string; noIssuePrompt: string }): LabeledPreview[] {
  const compile = (operatorPrompt: string, fields: DriveFields) =>
    buildCriticPrompt({
      operatorPrompt,
      fields,
      verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
      baseOid: SAMPLE_BASE_OID,
    });
  return [
    { label: 'Mirrored task (has ticket)', text: compile(prompts.issuePrompt, SAMPLE_DRIVE_FIELDS) },
    { label: 'Native task (no ticket)', text: compile(prompts.noIssuePrompt, SAMPLE_NATIVE_DRIVE_FIELDS) },
  ];
}

export function compileEpicCriticPreview(prompt: string): string {
  return buildCriticPrompt({
    operatorPrompt: prompt,
    fields: SAMPLE_DRIVE_FIELDS,
    verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
    baseOid: SAMPLE_BASE_OID,
  });
}

export function compileEpicResolvePreview(template: string): string {
  const prompt = template
    .replaceAll('{ref}', SAMPLE_DRIVE_FIELDS.ref)
    .replaceAll('{title}', SAMPLE_DRIVE_FIELDS.title)
    .replaceAll('{description}', SAMPLE_DRIVE_FIELDS.description)
    .replaceAll('{url}', SAMPLE_DRIVE_FIELDS.url);
  return [
    prompt,
    '',
    '## Failing Epic verification',
    'Example verifier feedback.',
    '',
    `Work in the checked-out integration branch \`epic/${SAMPLE_DRIVE_FIELDS.ref}\`. Fix the failure and commit the result. Do not create or switch branches, and do not push.`,
  ].join('\n');
}
