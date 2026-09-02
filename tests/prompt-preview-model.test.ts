import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DRIVE_FIELDS,
  SAMPLE_TASK_ID,
  compileCriticPreview,
  compileDrivePreview,
  compileTaskIdPreview,
  compileTaskPreview,
} from '../web/src/prompt-preview-model.js';
import { baselineConfig } from '../src/config.js';

describe('prompt-preview-model (settings compiled preview)', () => {
  it('compileDrivePreview fills the five Drive tokens with sample values', () => {
    const out = compileDrivePreview('issue {ref} — {title} ({url}) via {skill}: {body}');
    expect(out).toBe(
      `issue ${SAMPLE_DRIVE_FIELDS.ref} — ${SAMPLE_DRIVE_FIELDS.title} (${SAMPLE_DRIVE_FIELDS.url}) via ${SAMPLE_DRIVE_FIELDS.skill}: ${SAMPLE_DRIVE_FIELDS.body}`,
    );
    expect(out).not.toMatch(/\{(skill|ref|url|title|body)\}/);
  });

  it('compileTaskIdPreview fills {taskId}', () => {
    expect(compileTaskIdPreview('Task {taskId} running unattended')).toBe(`Task ${SAMPLE_TASK_ID} running unattended`);
  });

  it('compileTaskPreview fills the task-prompt tokens', () => {
    const config = baselineConfig();
    const out = compileTaskPreview('{prompt} [{id}/{harness}/{model}] in {workingDir}', config);
    expect(out).toBe(
      `Example task prompt. [123/${config.defaults.harness}/${config.harnesses[config.defaults.harness].defaultModel}] in /repo`,
    );
  });

  it('compileCriticPreview shows both Task-kind variants, each with the read-only + verdict scaffolding', () => {
    const [mirrored, native] = compileCriticPreview('Review issue {ref}: {title}.');
    if (!mirrored || !native) throw new Error('expected two compiled variants');

    expect(mirrored.label).toMatch(/mirrored/i);
    expect(mirrored.text).toContain(`Review issue ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(mirrored.text).toContain('the referenced ticket');

    expect(native.label).toMatch(/native/i);
    // Native Task has no ref: the token compiles to empty; title still fills from the prompt.
    expect(native.text).toContain(`Review issue : ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(native.text).toContain('there is no external ticket to consult');

    for (const { text } of [mirrored, native]) {
      expect(text).toMatch(/READ-ONLY/i);
      expect(text).toContain('"verdict":"pass|fail|inconclusive"');
      expect(text).not.toContain('HARMONIC_UNTRUSTED_DIFF');
    }
  });
});
