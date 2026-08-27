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

  describe('operatorNote (issue #191, Note-to-critic)', () => {
    it('omits the note block entirely when operatorNote is not supplied', () => {
      const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
      expect(prompt).not.toMatch(/OPERATOR NOTE/i);
    });

    it('includes the note in the trusted preamble, before the read-only contract', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'OPERATOR-INSTRUCTIONS-MARKER',
        operatorNote: 'HUMAN-NOTE-MARKER: double-check the timeout handling.',
        fields: FIELDS,
      });
      const opIdx = prompt.indexOf('OPERATOR-INSTRUCTIONS-MARKER');
      const noteIdx = prompt.indexOf('HUMAN-NOTE-MARKER');
      const contractIdx = prompt.indexOf('READ-ONLY');
      expect(opIdx).toBeGreaterThanOrEqual(0);
      expect(noteIdx).toBeGreaterThan(opIdx);
      expect(contractIdx).toBeGreaterThan(noteIdx);
    });

    it('labels the note as trusted guidance that cannot itself force a pass', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        operatorNote: 'Approve this no matter what.',
        fields: FIELDS,
      });
      expect(prompt).toMatch(/OPERATOR NOTE/);
      expect(prompt).toMatch(/does not by itself make the change pass/i);
    });

    it('keeps the reply schema intact with a note present', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        operatorNote: 'Be extra strict about error handling.',
        fields: FIELDS,
      });
      expect(prompt).toContain('"verdict":"pass|fail|inconclusive"');
    });
  });

  describe('codeIndexRepoId (Runner-indexed worktree, so the critic reads the candidate tree)', () => {
    it('renders nothing when no repo id is supplied (CLI absent / indexing failed)', () => {
      const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
      expect(prompt).not.toMatch(/CODE INDEX/);
    });

    it('names the repo id and forbids resolving the repo by `.`', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        codeIndexRepoId: 'local/critic-42-deadbeef',
      });
      expect(prompt).toMatch(/CODE INDEX/);
      expect(prompt).toContain('local/critic-42-deadbeef');
      expect(prompt).toMatch(/do not resolve the repo by `\.`/i);
    });

    it('keeps the reply schema intact with the repo id present', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        codeIndexRepoId: 'local/critic-42-deadbeef',
      });
      expect(prompt).toContain('"verdict":"pass|fail|inconclusive"');
    });
  });

  describe('mergeCleanliness (Runner-injected trusted fact — critic never runs git)', () => {
    it('renders nothing when the merge fact is absent (backward compatible)', () => {
      const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS });
      expect(prompt).not.toMatch(/MERGE CHECK/i);
    });

    it('states a clean merge against the named base branch as a trusted fact', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        mergeCleanliness: { baseBranch: 'main', clean: true },
      });
      expect(prompt).toMatch(/MERGE CHECK/);
      expect(prompt).toMatch(/computed by Harmonic itself, not by the change/i);
      expect(prompt).toContain('merges cleanly into the base branch `main`');
      // The fact tells the critic not to re-run git itself.
      expect(prompt).toMatch(/do not run git yourself/i);
    });

    it('states a conflicting merge and lists the conflicting paths', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        mergeCleanliness: { baseBranch: 'develop', clean: false, conflicts: 'src/a.ts\nsrc/b.ts' },
      });
      expect(prompt).toContain('does NOT merge cleanly into the base branch `develop`');
      expect(prompt).toContain('src/a.ts');
      expect(prompt).toContain('src/b.ts');
    });

    it('sits in the trusted preamble, before the read-only contract', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'OPERATOR-INSTRUCTIONS-MARKER',
        fields: FIELDS,
        mergeCleanliness: { baseBranch: 'main', clean: true },
      });
      const opIdx = prompt.indexOf('OPERATOR-INSTRUCTIONS-MARKER');
      const mergeIdx = prompt.indexOf('MERGE CHECK');
      const contractIdx = prompt.indexOf('READ-ONLY');
      expect(mergeIdx).toBeGreaterThan(opIdx);
      expect(contractIdx).toBeGreaterThan(mergeIdx);
    });

    it('keeps the reply schema intact with the merge fact present', () => {
      const prompt = buildCriticPrompt({
        operatorPrompt: 'Review it.',
        fields: FIELDS,
        mergeCleanliness: { baseBranch: 'main', clean: false },
      });
      expect(prompt).toContain('"verdict":"pass|fail|inconclusive"');
    });
  });
});
