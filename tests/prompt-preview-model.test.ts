import { describe, expect, it } from 'vitest';
import {
  CRITIC_NO_ISSUE_PLACEHOLDERS,
  EPIC_RESOLVE_PLACEHOLDERS,
  SAMPLE_DRIVE_FIELDS,
  SAMPLE_TASK_ID,
  compileCriticPreview,
  compileDrivePreview,
  compileEpicCriticPreview,
  compileEpicResolvePreview,
  compileTaskIdPreview,
  compileTaskPreview,
} from '../web/src/prompt-preview-model.js';
import { baselineConfig } from '../src/config.js';

describe('prompt-preview-model (settings compiled preview)', () => {
  it('offers the core Task-identity tokens plus {skill} for a native Task critic (no ticket ref/url)', () => {
    expect(CRITIC_NO_ISSUE_PLACEHOLDERS.map((p) => p.token)).toEqual(['{taskId}', '{title}', '{description}', '{skill}']);
    expect(CRITIC_NO_ISSUE_PLACEHOLDERS.filter((p) => p.core).map((p) => p.token)).toEqual([
      '{taskId}',
      '{title}',
      '{description}',
    ]);
  });

  it('compileDrivePreview fills the Drive tokens with sample values', () => {
    const out = compileDrivePreview('task {taskId}: issue {ref} — {title} ({url}) via {skill}: {description}');
    expect(out).toBe(
      `task ${SAMPLE_DRIVE_FIELDS.taskId}: issue ${SAMPLE_DRIVE_FIELDS.ref} — ${SAMPLE_DRIVE_FIELDS.title} (${SAMPLE_DRIVE_FIELDS.url}) via ${SAMPLE_DRIVE_FIELDS.skill}: ${SAMPLE_DRIVE_FIELDS.description}`,
    );
    expect(out).not.toMatch(/\{(taskId|skill|ref|url|title|description)\}/);
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
    const [mirrored, native] = compileCriticPreview({
      issuePrompt: 'Review issue {ref}: {title}.',
      noIssuePrompt: 'Review task {taskId} — {title} via {skill}.',
    });
    if (!mirrored || !native) throw new Error('expected two compiled variants');

    expect(mirrored.label).toMatch(/mirrored/i);
    expect(mirrored.text).toContain(`Review issue ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(mirrored.text).toContain('the referenced ticket');

    expect(native.label).toMatch(/native/i);
    // The Task-identity tokens resolve even with no ticket — the feature gap this closed.
    expect(native.text).toContain(
      `Review task ${SAMPLE_DRIVE_FIELDS.taskId} — ${SAMPLE_DRIVE_FIELDS.title} via ${SAMPLE_DRIVE_FIELDS.skill}.`,
    );
    expect(native.text).toContain('there is no external ticket to consult');

    for (const { text } of [mirrored, native]) {
      expect(text).toMatch(/READ-ONLY/i);
      expect(text).toContain('"verdict":"pass|fail|inconclusive"');
      expect(text).not.toContain('HARMONIC_UNTRUSTED_DIFF');
    }
  });

  it('compiles an Epic critic against its ticket context', () => {
    const out = compileEpicCriticPreview('Review Epic {ref}: {title}.');

    expect(out).toContain(`Review Epic ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(out).toContain('the referenced ticket');
    expect(out).toMatch(/READ-ONLY/i);
  });

  it('matches the Epic resolver prompt and offers its supported tokens', () => {
    expect(EPIC_RESOLVE_PLACEHOLDERS.map((p) => p.token)).toEqual(['{title}', '{description}', '{ref}', '{url}']);
    expect(compileEpicResolvePreview('Fix {ref}: {title} — {description}')).toContain(
      `Fix ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title} — ${SAMPLE_DRIVE_FIELDS.description}`,
    );
    expect(compileEpicResolvePreview('Fix {ref}.')).toContain('## Failing Epic verification');
  });
});
