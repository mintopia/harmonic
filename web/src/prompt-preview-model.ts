import { fillTemplate, type DriveFields } from '../../src/execution/prompt-template.js';
import { buildCriticPrompt } from '../../src/verification/critic-prompt.js';

/**
 * Compile the settings prompts to the exact text the server would send, so each
 * editor can show a full "Compiled preview" (issue: operator-authored prompts).
 * The preview is fidelity-critical, so it calls the SAME pure builders the server
 * uses (`prompt-template.ts`, `critic-prompt.ts`) rather than re-implementing the
 * interpolation or the critic scaffolding — the only difference is that the
 * tokens are filled with illustrative sample values instead of a live Task's.
 */

/** Illustrative values for the `{skill}/{ref}/{url}/{title}/{body}` tokens. */
export const SAMPLE_DRIVE_FIELDS: DriveFields = {
  skill: '/implement',
  ref: '123',
  url: 'https://github.com/acme/repo/issues/123',
  title: 'Example issue title',
  body: 'Example issue body describing the change to make.',
};

/** Illustrative value for the `{taskId}` token. */
export const SAMPLE_TASK_ID = '123';

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
export function compileTaskPreview(template: string): string {
  return fillTemplate(template, {
    prompt: 'Example task prompt.',
    id: 123,
    workingDir: '/repo',
    harness: 'claude',
    model: 'claude-opus-5',
  });
}

/** Fill the `{taskId}` token with the sample value. */
export function compileTaskIdPreview(template: string): string {
  return template.replace(/\{taskId\}/g, SAMPLE_TASK_ID);
}

/** Compile the critic review prompt exactly as `runCritic` would: the operator
 * note interpolated, plus the appended read-only + JSON-verdict scaffolding. */
export function compileCriticPreview(operatorPrompt: string): string {
  return buildCriticPrompt({ operatorPrompt, fields: SAMPLE_DRIVE_FIELDS });
}
