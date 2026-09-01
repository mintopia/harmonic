import { describe, expect, it } from 'vitest';
import { buildCriticPrompt } from '../src/verification/critic-prompt.js';
import type { DriveFields } from '../src/execution/prompt-template.js';

const FIELDS: DriveFields = {
  skill: '/implement',
  ref: '123',
  url: 'https://tracker.example/issues/123',
  title: 'Fix the timeout',
  body: 'The request hangs forever.',
};

const CANDIDATE = 'cand0000000000000000000000000000000000000';
const BASE = 'base0000000000000000000000000000000000000';

describe('buildCriticPrompt (issue #136; 2026-08 containment amendment)', () => {
  it('interpolates the Drive-Prompt tokens into the operator prompt', () => {
    const prompt = buildCriticPrompt({
      operatorPrompt: 'Review issue {ref} ({url}): {title}. Skill {skill}. Body: {body}',
      fields: FIELDS,
      verifiedHeadOid: CANDIDATE,
    });
    expect(prompt).toContain('Review issue 123 (https://tracker.example/issues/123): Fix the timeout.');
    expect(prompt).toContain('Skill /implement.');
    expect(prompt).toContain('Body: The request hangs forever');
    expect(prompt).not.toMatch(/\{(skill|ref|url|title|body)\}/);
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
});
