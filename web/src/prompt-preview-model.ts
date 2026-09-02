import { fillTemplate, type DriveFields } from '../../src/execution/prompt-template.js';
import { buildCriticPrompt } from '../../src/verification/critic-prompt.js';
import type { AppConfig } from './types';

/** Illustrative values for the `{skill}/{ref}/{url}/{title}/{body}` tokens. */
export const SAMPLE_DRIVE_FIELDS: DriveFields = {
  skill: '/implement',
  ref: '123',
  url: 'https://github.com/acme/repo/issues/123',
  title: 'Example issue title',
  body: 'Example issue body describing the change to make.',
};

/** A native (board-authored) Task has no mirrored issue: `ref`/`url` are empty, so
 * `buildCriticPrompt` compiles its no-ticket variant. `title`/`body` still come
 * from the Task's own prompt (`driveFields`), so they stay populated. */
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

/** Placeholder metadata (token, description) shared by the drive prompt and the
 * critic review prompt — they take the same five tokens. */
export const DRIVE_PLACEHOLDERS: [string, string][] = [
  ['{skill}', 'workflow skill — /research or /implement'],
  ['{ref}', 'issue number'],
  ['{url}', 'issue URL'],
  ['{title}', 'issue title'],
  ['{body}', 'issue body'],
];

export const TASK_ID_PLACEHOLDER: [string, string][] = [['{taskId}', 'Harmonic task id']];

export const TASK_PLACEHOLDERS: [string, string][] = [
  ['{prompt}', "the task's own prompt"],
  ['{id}', 'task id'],
  ['{workingDir}', 'working directory'],
  ['{harness}', 'harness id'],
  ['{model}', 'model id'],
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
export function compileCriticPreview(operatorPrompt: string): LabeledPreview[] {
  const compile = (fields: DriveFields) =>
    buildCriticPrompt({
      operatorPrompt,
      fields,
      verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
      baseOid: SAMPLE_BASE_OID,
    });
  return [
    { label: 'Mirrored task (has ticket)', text: compile(SAMPLE_DRIVE_FIELDS) },
    { label: 'Native task (no ticket)', text: compile(SAMPLE_NATIVE_DRIVE_FIELDS) },
  ];
}
