import { baselineConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCriticPrompt as buildWithFragments, type BuildCriticPromptArgs } from '../src/execution/prompt-assembly.js';
import type { DriveFields } from '../src/execution/prompt-template.js';

const DEFAULT_PROMPT_FRAGMENTS = baselineConfig().promptFragments;

const FIELDS: DriveFields = {
  taskId: '172',
  skill: '/implement',
  ref: '123',
  url: 'https://tracker.example/issues/123',
  title: 'Fix the timeout',
  description: 'The request hangs forever.',
};

const buildCriticPrompt = (args: Omit<BuildCriticPromptArgs, 'fragments'>): string =>
  buildWithFragments({ ...args, fragments: DEFAULT_PROMPT_FRAGMENTS });

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

  it('does not forbid credential use, leaving that to the operator prompt', () => {
    const prompt = buildCriticPrompt({ operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE });
    expect(prompt).not.toMatch(/no credentials/i);
    expect(prompt).not.toMatch(/privileged service/i);
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

describe('critic Prompt Fragments', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/critic-prompt-golden.json', import.meta.url), 'utf8')) as Record<string, string>;
  const native: DriveFields = { ...FIELDS, ref: '', url: '' };

  it('assembles byte-for-byte the pre-fragment prompt when fragments are at defaults', () => {
    const op = (text: string) => ({ operatorPrompt: text });
    const built = {
      ticketDiff: buildCriticPrompt({ ...op('Review {ref}.'), fields: { ...FIELDS, ref: '123', url: 'https://t/123', title: 'T', description: 'D' }, verifiedHeadOid: 'HEAD1', baseOid: 'BASE1' }),
      ticketDirty: buildCriticPrompt({ ...op('Review {ref}.'), fields: { ...FIELDS, ref: '123', url: 'https://t/123', title: 'T', description: 'D' }, verifiedHeadOid: 'HEAD1', baseOid: 'BASE1', dirty: true }),
      nativeIdentical: buildCriticPrompt({ ...op('Review {title}.'), fields: { ...native, title: 'T', description: 'D', url: '' }, verifiedHeadOid: 'HEAD1', baseOid: 'HEAD1' }),
      ticketAlone: buildCriticPrompt({ ...op('Review {ref}.'), fields: { ...FIELDS, ref: '123', url: 'https://t/123', title: 'T', description: 'D' }, verifiedHeadOid: 'HEAD1' }),
      nativeAloneDirty: buildCriticPrompt({ ...op('Review.'), fields: { ...native, title: 'T', description: 'D', url: '' }, verifiedHeadOid: 'HEAD1', dirty: true }),
    };
    expect(built).toEqual(golden);
  });

  it('puts an edited fragment into the Resolved Prompt, in the matching revision variant only', () => {
    const fragments = {
      ...DEFAULT_PROMPT_FRAGMENTS,
      criticRevisionDiff: 'EDITED-DIFF head={head} base={base}.{workingTreeNote}',
      criticRevisionIdentical: 'EDITED-SAME {head}',
      criticRevisionAlone: 'EDITED-ALONE {head}',
      readOnlyRestraint: 'EDITED-RESTRAINT',
      criticVerdictContract: 'EDITED-CONTRACT {"verdict":"pass","summary":"x"}',
    };
    const args = { operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE, fragments };
    const diff = buildWithFragments({ ...args, baseOid: BASE });
    expect(diff).toContain(`EDITED-DIFF head=${CANDIDATE} base=${BASE}.`);
    expect(diff).toContain('EDITED-RESTRAINT');
    expect(diff).toContain('EDITED-CONTRACT');
    expect(diff).not.toContain('EDITED-SAME');
    expect(buildWithFragments({ ...args, baseOid: CANDIDATE })).toContain(`EDITED-SAME ${CANDIDATE}`);
    expect(buildWithFragments(args)).toContain(`EDITED-ALONE ${CANDIDATE}`);
  });

  it('makes every piece of critic prose an editable fragment, expanding {fragment.x} references inside them', () => {
    const fragments = {
      ...DEFAULT_PROMPT_FRAGMENTS,
      readOnlyRestraint: 'SHARED-RESTRAINT',
      criticRole: 'ROLE-EDITED. {fragment.readOnlyRestraint}',
      criticSecurity: 'SECURITY-EDITED',
      criticTicketFirst: 'TICKET-FIRST-EDITED',
      criticInstructionsFirst: 'INSTRUCTIONS-FIRST-EDITED',
      criticSpecTicket: 'SPEC-TICKET-EDITED',
      criticSpecInstructions: 'SPEC-INSTRUCTIONS-EDITED',
      criticWorkingTreeNote: 'DIRTY-EDITED against {base} at {head}',
      criticRevisionDiff: '{ticketFirst} vs {spec}: {head}/{base} {fragment.criticSpecTicket}{workingTreeNote}',
    };
    const args = { operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE, baseOid: BASE, fragments };
    const clean = buildWithFragments(args);
    expect(clean).toContain(`TICKET-FIRST-EDITED vs SPEC-TICKET-EDITED: ${CANDIDATE}/${BASE} SPEC-TICKET-EDITED\n`);
    expect(clean).toContain('ROLE-EDITED. SHARED-RESTRAINT');
    expect(clean).toContain('SECURITY-EDITED');
    expect(clean).not.toContain('{fragment.');
    expect(clean).not.toContain('READ-ONLY code critic');
    expect(clean).not.toContain('UNTRUSTED DATA');
    expect(clean).not.toContain('DIRTY-EDITED');
    expect(buildWithFragments({ ...args, dirty: true })).toContain(`SPEC-TICKET-EDITED DIRTY-EDITED against ${BASE} at ${CANDIDATE}\n`);
    const native = { ...FIELDS, ref: '', url: '' };
    expect(buildWithFragments({ ...args, fields: native })).toContain('INSTRUCTIONS-FIRST-EDITED vs SPEC-INSTRUCTIONS-EDITED:');
  });

  it('leaves an unknown {fragment.name} literal, so save-time validation is the only guard', () => {
    const fragments = { ...DEFAULT_PROMPT_FRAGMENTS, criticRole: 'ROLE {fragment.nope}' };
    expect(buildWithFragments({ operatorPrompt: 'Review it.', fields: FIELDS, verifiedHeadOid: CANDIDATE, fragments })).toContain('ROLE {fragment.nope}');
  });
});
