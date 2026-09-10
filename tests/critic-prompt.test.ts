import { describe, expect, it } from 'vitest';
import { buildCriticPrompt } from '../src/verification/critic-prompt.js';
import type { DriveFields } from '../src/execution/prompt-template.js';

const FIELDS: DriveFields = {
  taskId: '172',
  skill: '/implement',
  ref: '123',
  url: 'https://tracker.example/issues/123',
  title: 'Fix the timeout',
  description: 'The request hangs forever.',
};

const CANDIDATE = 'cand0000000000000000000000000000000000000';
const BASE = 'base0000000000000000000000000000000000000';

describe('buildCriticPrompt (issue #136; 2026-08 containment amendment)', () => {
  it('interpolates the Drive-Prompt tokens into the operator prompt', () => {
    const prompt = buildCriticPrompt({
      operatorPrompt: 'Task {taskId}: Review issue {ref} ({url}): {title}. Skill {skill}. Body: {description}',
      fields: FIELDS,
      verifiedHeadOid: CANDIDATE,
    });
    expect(prompt).toContain('Task 172: Review issue 123 (https://tracker.example/issues/123): Fix the timeout.');
    expect(prompt).toContain('Skill /implement.');
    expect(prompt).toContain('Body: The request hangs forever');
    expect(prompt).not.toMatch(/\{(taskId|skill|ref|url|title|description)\}/);
  });

  it('injects no diff and no nonce/delimiter markers', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE });
    expect(prompt).not.toContain('HARMONIC_UNTRUSTED_DIFF');
    expect(prompt).not.toContain('<<<END');
  });

  it('states the read-only contract — may read/fetch, must not modify', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE });
    expect(prompt).toMatch(/READ-ONLY/i);
    expect(prompt).toMatch(/must not edit/i);
    expect(prompt).toMatch(/may read/i);
    expect(prompt).toMatch(/network request/i);
  });

  it('warns that file contents and fetched pages are untrusted data', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE });
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toMatch(/never instructions/i);
  });

  it('specifies the exact JSON output contract', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE });
    expect(prompt).toContain('"verdict":"pass|fail|inconclusive"');
    expect(prompt).toContain('"summary"');
  });

  it('is pure — same inputs give the same output', () => {
    const args = { operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE } as const;
    expect(buildCriticPrompt(args)).toBe(buildCriticPrompt(args));
  });

  describe('revision block (the critic is given the two revisions, never a git diff)', () => {
    it('names both revisions and points the critic at `git diff` itself when the base is known', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        verifiedHeadOid: CANDIDATE,
        baseOid: BASE,
      });
      expect(prompt).toContain(CANDIDATE);
      expect(prompt).toContain(BASE);
      expect(prompt).toMatch(/branched from/);
      expect(prompt).toContain(`git diff ${BASE} ${CANDIDATE}`);
      expect(prompt).toContain('You are NOT handed a diff.');
      expect(prompt).not.toMatch(/CODE INDEX/);
      expect(prompt).not.toMatch(/diff --git/);
    });

    it('reviews the candidate on its own merits when the base is unknown', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        verifiedHeadOid: CANDIDATE,
      });
      expect(prompt).toContain(CANDIDATE);
      expect(prompt).toMatch(/on its own merits/i);
      expect(prompt).not.toContain(BASE);
      expect(prompt).not.toMatch(/branched from/);
    });

    it('is pure with both revisions present', () => {
      const args = { operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE, baseOid: BASE } as const;
      expect(buildCriticPrompt(args)).toBe(buildCriticPrompt(args));
    });

    it('judges against the ticket, not the (empty) diff, when the candidate is identical to the base', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        verifiedHeadOid: CANDIDATE,
        baseOid: CANDIDATE,
      });
      expect(prompt).toMatch(/identical to the base/i);
      expect(prompt).toMatch(/no-change result is correct/i);
      expect(prompt).toMatch(/do not fail merely\s+because there is no diff/i);
      expect(prompt).not.toContain(`git diff ${CANDIDATE} ${CANDIDATE}`);
      expect(prompt).not.toMatch(/branched from/);
    });

    it('reads the ticket first in every revision-block variant', () => {
      for (const baseOid of [BASE, CANDIDATE, undefined]) {
        const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE, ...(baseOid ? { baseOid } : {}) });
        expect(prompt).toMatch(/First read the referenced ticket/i);
      }
    });
  });

  describe('native (board-authored) Task — no mirrored ticket', () => {
    const NATIVE_FIELDS: DriveFields = {
      taskId: '288',
      skill: '/implement',
      ref: '',
      url: '',
      title: 'Add a flag',
      description: 'Wire it through.',
    };

    it('does not tell the critic to read a ticket that does not exist', () => {
      for (const baseOid of [BASE, CANDIDATE, undefined]) {
        const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: NATIVE_FIELDS, verifiedHeadOid: CANDIDATE, ...(baseOid ? { baseOid } : {}) });
        expect(prompt).not.toMatch(/First read the referenced ticket/i);
        expect(prompt).toMatch(/Judge the candidate against the review instructions above/i);
      }
    });

    it('still resolves the Task-identity tokens (taskId/title/description) with no ticket', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review task {taskId} — {title}. {description} Skill {skill}. Ticket: [{ref}{url}]',
        fields: NATIVE_FIELDS,
        verifiedHeadOid: CANDIDATE,
      });
      expect(prompt).toContain('Review task 288 — Add a flag. Wire it through. Skill /implement.');
      // ref/url are the only ticket-only tokens; they resolve to empty for a native Task.
      expect(prompt).toContain('Ticket: []');
      expect(prompt).not.toMatch(/\{(taskId|title|description|skill|ref|url)\}/);
    });

    it('judges against the instructions, not a ticket, on the no-change branch', () => {
      const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: NATIVE_FIELDS, verifiedHeadOid: CANDIDATE, baseOid: CANDIDATE });
      expect(prompt).toMatch(/when the review instructions above required none/i);
      expect(prompt).not.toMatch(/Decide from the ticket/i);
    });
  });
});
