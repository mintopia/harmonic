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

describe('buildCriticPrompt (issue #136; 2026-08 containment amendment)', () => {
  it('interpolates the Drive-Prompt tokens into the operator prompt', () => {
    const prompt = buildCriticPrompt({
      operatorPrompt: 'Review issue {ref} ({url}): {title}. Skill {skill}. Body: {body}',
      fields: FIELDS,
    });
    expect(prompt).toContain('Review issue 123 (https://tracker.example/issues/123): Fix the timeout.');
    expect(prompt).toContain('Skill /implement.');
    expect(prompt).toContain('Body: The request hangs forever');
    // No token survives uninterpolated.
    expect(prompt).not.toMatch(/\{(skill|ref|url|title|body)\}/);
  });

  it('injects no diff and no nonce/delimiter markers', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
    expect(prompt).not.toContain('HARMONIC_UNTRUSTED_DIFF');
    expect(prompt).not.toContain('<<<END');
  });

  it('states the read-only contract — may read/fetch, must not modify', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
    expect(prompt).toMatch(/READ-ONLY/i);
    expect(prompt).toMatch(/must not edit/i);
    expect(prompt).toMatch(/may read/i);
    expect(prompt).toMatch(/network request/i);
  });

  it('warns that file contents and fetched pages are untrusted data', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toMatch(/never instructions/i);
  });

  it('specifies the exact JSON output contract', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
    expect(prompt).toContain('"verdict":"pass|fail|inconclusive"');
    expect(prompt).toContain('"summary"');
  });

  it('is pure — same inputs give the same output', () => {
    const args = { operatorPrompt: 'Review it.', fields: FIELDS } as const;
    expect(buildCriticPrompt(args)).toBe(buildCriticPrompt(args));
  });

  describe('candidateRepoId (Runner-indexed candidate worktree, so the critic reads the candidate tree)', () => {
    it('renders nothing when no repo id is supplied (CLI absent / indexing failed)', () => {
      const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
      expect(prompt).not.toMatch(/CODE INDEX/);
    });

    it('names the candidate repo id and forbids resolving the repo by `.`', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        candidateRepoId: 'local/critic-42-deadbeef',
      });
      expect(prompt).toMatch(/CODE INDEX/);
      expect(prompt).toContain('local/critic-42-deadbeef');
      expect(prompt).toMatch(/do not resolve the repo by `\.`/i);
    });

    it('keeps the reply schema intact with the repo id present', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        candidateRepoId: 'local/critic-42-deadbeef',
      });
      expect(prompt).toContain('"verdict":"pass|fail|inconclusive"');
    });
  });

  describe('base + candidate revisions (the critic is given the two revisions, never a git diff)', () => {
    it('names BOTH revisions and tells the critic to compare them via the index', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        baseRepoId: 'local/critic-42-base-cafe',
        candidateRepoId: 'local/critic-42-deadbeef',
      });
      expect(prompt).toMatch(/CODE INDEX/);
      expect(prompt).toContain('local/critic-42-base-cafe');
      expect(prompt).toContain('local/critic-42-deadbeef');
      expect(prompt).toMatch(/BASE \(before the change\)/);
      expect(prompt).toMatch(/CANDIDATE \(the change under review\)/);
      expect(prompt).toMatch(/get_parity_map/);
      // No raw diff is ever injected — the critic derives the change from the index.
      expect(prompt).not.toMatch(/diff --git/);
    });

    it('falls back to candidate-only guidance when the base revision was not indexed', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        candidateRepoId: 'local/critic-42-deadbeef',
      });
      expect(prompt).toContain('local/critic-42-deadbeef');
      expect(prompt).not.toMatch(/BASE \(before the change\)/);
    });

    it('renders no comparison block when only the base was indexed (the candidate is the reviewed tree)', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        baseRepoId: 'local/critic-42-base-cafe',
      });
      expect(prompt).not.toMatch(/CODE INDEX/);
    });
  });
});
