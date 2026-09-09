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
  it('only offers ticket-free tokens for a native Task critic body', () => {
    expect(CRITIC_NO_ISSUE_PLACEHOLDERS).toEqual([['{skill}', 'workflow skill — /research or /implement']]);
  });

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
    const [mirrored, native] = compileCriticPreview({ issuePrompt: 'Review issue {ref}: {title}.', noIssuePrompt: 'Review the Task via {skill}.' });
    if (!mirrored || !native) throw new Error('expected two compiled variants');

    expect(mirrored.label).toMatch(/mirrored/i);
    expect(mirrored.text).toContain(`Review issue ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(mirrored.text).toContain('the referenced ticket');

    expect(native.label).toMatch(/native/i);
    expect(native.text).toContain(`Review the Task via ${SAMPLE_DRIVE_FIELDS.skill}.`);
    expect(native.text).not.toContain(SAMPLE_DRIVE_FIELDS.title);
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

  it('matches the Epic resolver prompt and only offers its supported tokens', () => {
    expect(EPIC_RESOLVE_PLACEHOLDERS).toEqual([
      ['{ref}', 'Epic issue number'],
      ['{title}', 'Epic issue title'],
    ]);
    expect(compileEpicResolvePreview('Fix {ref}: {title}.')).toContain(
      `Fix ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`,
    );
    expect(compileEpicResolvePreview('Fix {ref}.')).toContain('## Failing Epic verification');
  });
});
