import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DRIVE_FIELDS,
  SAMPLE_TASK_ID,
  compileCriticPreview,
  compileDrivePreview,
  compileTaskIdPreview,
  compileTaskPreview,
} from '../web/src/prompt-preview-model.js';

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
    const out = compileTaskPreview('{prompt} [{id}/{harness}/{model}] in {workingDir}');
    expect(out).toBe('Example task prompt. [123/claude/claude-opus-5] in /repo');
  });

  it('compileCriticPreview interpolates the note AND appends the read-only + verdict scaffolding', () => {
    const out = compileCriticPreview('Review issue {ref}: {title}.');
    expect(out).toContain(`Review issue ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(out).toMatch(/READ-ONLY/i);
    expect(out).toContain('"verdict":"pass|fail|inconclusive"');
    expect(out).not.toContain('HARMONIC_UNTRUSTED_DIFF');
  });
});
