import { describe, it, expect } from 'vitest';
import type { RunFactRow, RunEventRow } from '../src/db/schema.js';
import type { PersistedRunEvent } from '../src/domain/runs.js';
import {
  FALLBACK_TRIGGER_REASONS,
  isFallbackTriggerReason,
  classifyReloadFailure,
  planResumeFallback,
  buildResumeFallbackSummary,
  type FallbackSummaryInput,
} from '../src/domain/session-fallback.js';

/**
 * The issue #145 seam test: the deterministic summarized-Session fallback —
 * both halves, driven in isolation as pure functions (no db, no clock). Proves
 * the at-most-once gate (AC1/AC4), the deterministic summary built from the four
 * persisted inputs (AC2/AC3), and that the summary is Harmonic-authored — built
 * from inputs alone, never by asking the dead Session (AC2). AC5 (persisting the
 * reason on the Session row) lives in `tests/sessions.test.ts`.
 */

function baseInput(overrides: Partial<FallbackSummaryInput> = {}): FallbackSummaryInput {
  return {
    trigger: 'adapter-version-mismatch',
    detail: 'stored adapter claude@1 != current claude@2',
    session: { harness: 'claude', model: 'opus', cwd: '/repo', harnessSessionId: 'sess-abc' },
    candidate: { oid: 'deadbeef', status: 'created' },
    facts: [
      { seq: 1, type: 'run-start-state', payload: '{"branch":"feat"}' },
      { seq: 2, type: 'agent-finish/unresolved', payload: '{}' },
    ],
    events: [
      { seq: 1, type: 'session_update', payload: { chunk: 'a' } },
      { seq: 2, type: 'lifecycle', payload: { event: 'candidate', status: 'created' } },
    ],
    trackerLinks: [{ number: 145, title: 'summarized fallback', state: 'open' }],
    ...overrides,
  };
}

describe('FALLBACK_TRIGGER_REASONS / classification (issue #145 AC1)', () => {
  it('covers the union of the #142 and #143 reason sets, deduped', () => {
    // The five #142 axes plus #143's additional-directories axis; the two shared
    // reasons appear once.
    expect([...FALLBACK_TRIGGER_REASONS].sort()).toEqual(
      [
        'additional-directories-unsupported',
        'adapter-version-mismatch',
        'cwd-mismatch',
        'harness-mismatch',
        'load-session-unsupported',
        'permission-mode-unestablishable',
      ].sort(),
    );
  });

  it('isFallbackTriggerReason narrows a classified failure and rejects anything else', () => {
    expect(isFallbackTriggerReason('cwd-mismatch')).toBe(true);
    expect(isFallbackTriggerReason('permission-mode-unestablishable')).toBe(true);
    expect(isFallbackTriggerReason('landed')).toBe(false); // a retire reason, not a reload failure
    expect(isFallbackTriggerReason('')).toBe(false);
  });

  it('classifyReloadFailure is the identity map from a #142/#143 outcome into a ReloadFailure', () => {
    expect(classifyReloadFailure('load-session-unsupported', 'no session/load')).toEqual({
      reason: 'load-session-unsupported',
      detail: 'no session/load',
    });
    // A #143-only reason routes through the same seam.
    expect(classifyReloadFailure('additional-directories-unsupported', 'roots needed').reason).toBe(
      'additional-directories-unsupported',
    );
  });
});

describe('planResumeFallback — the at-most-once gate (issue #145 AC1/AC4)', () => {
  it('no classified failure ⇒ reload, no fallback', () => {
    expect(planResumeFallback(null, { fallbackUsed: false })).toEqual({ action: 'reload' });
  });

  it('first classified failure ⇒ the single summarized fallback', () => {
    const plan = planResumeFallback(
      { reason: 'cwd-mismatch', detail: 'stored /a != /b' },
      { fallbackUsed: false },
    );
    expect(plan).toEqual({ action: 'summarized-fallback', trigger: 'cwd-mismatch', detail: 'stored /a != /b' });
  });

  it('a second classified failure after the fallback was spent ⇒ abort, never a loop', () => {
    const plan = planResumeFallback(
      { reason: 'harness-mismatch', detail: 'claude != codex' },
      { fallbackUsed: true },
    );
    expect(plan).toEqual({
      action: 'abort',
      reason: 'fallback-exhausted',
      trigger: 'harness-mismatch',
      detail: 'claude != codex',
    });
  });
});

describe('buildResumeFallbackSummary — deterministic Harmonic-built summary (issue #145 AC2/AC3)', () => {
  it('is deterministic: identical inputs yield byte-identical output', () => {
    expect(buildResumeFallbackSummary(baseInput())).toBe(buildResumeFallbackSummary(baseInput()));
  });

  it('input ordering does not change the output: facts/events/links are sorted by their stable key', () => {
    const ordered = baseInput();
    const shuffled = baseInput({
      facts: [...baseInput().facts].reverse(),
      events: [...baseInput().events].reverse(),
      trackerLinks: [
        { number: 200, title: 'later', state: 'open' },
        { number: 145, title: 'summarized fallback', state: 'open' },
      ],
    });
    const orderedWithTwoLinks = baseInput({
      trackerLinks: [
        { number: 145, title: 'summarized fallback', state: 'open' },
        { number: 200, title: 'later', state: 'open' },
      ],
    });
    // Reversed facts/events produce the same rendering (sorted by seq).
    expect(buildResumeFallbackSummary(shuffled)).toBe(buildResumeFallbackSummary(orderedWithTwoLinks));
    // sanity: the reversed-fact input is genuinely different from the base (which has one link).
    expect(buildResumeFallbackSummary(shuffled)).not.toBe(buildResumeFallbackSummary(ordered));
  });

  it('states why it exists and that the dead Session was not consulted (AC2)', () => {
    const out = buildResumeFallbackSummary(baseInput());
    expect(out).toContain('adapter-version-mismatch');
    expect(out).toContain('stored adapter claude@1 != current claude@2');
    expect(out).toContain('the prior Session was not asked to summarize itself');
  });

  it('renders all four persisted inputs: session, candidate, tracker links, facts, events', () => {
    const out = buildResumeFallbackSummary(baseInput());
    expect(out).toContain('- Harness: claude');
    expect(out).toContain('- Harness session id: sess-abc');
    expect(out).toContain('- Commit OID: deadbeef');
    expect(out).toContain('- Status: created');
    expect(out).toContain('- #145 summarized fallback [open]');
    expect(out).toContain('- #1 run-start-state — branch=feat');
    expect(out).toContain('- #2 agent-finish/unresolved');
    expect(out).toContain('- session_update: 1');
    expect(out).toContain('- lifecycle: 1');
    expect(out).toContain('Last lifecycle:');
  });

  it('derives the terminal disposition via computeDisposition precedence (escalate outranks failed)', () => {
    const out = buildResumeFallbackSummary(
      baseInput({
        facts: [
          { seq: 1, type: 'failed', payload: '{}' },
          { seq: 2, type: 'escalate', payload: '{"why":"blocked"}' },
        ],
      }),
    );
    expect(out).toContain('- Terminal disposition: escalate');
  });

  it('handles the empty case: no candidate, no tracker links, no facts, no events', () => {
    const out = buildResumeFallbackSummary(
      baseInput({
        candidate: { oid: null, status: null },
        facts: [],
        events: [],
        trackerLinks: [],
      }),
    );
    expect(out).toContain('- Commit OID: (none produced)');
    expect(out).toContain('- Status: (unknown)');
    expect(out).toContain('- (no linked tracker issues)');
    expect(out).toContain('- (no ending signals recorded)');
    expect(out).toContain('- (no events recorded)');
    expect(out).toContain('- Terminal disposition: (did not reach a terminal disposition)');
  });

  it('fact payload digest sorts keys and is bounded, so a huge/odd payload cannot reorder or bloat', () => {
    const long = 'x'.repeat(500);
    const out = buildResumeFallbackSummary(
      baseInput({
        facts: [{ seq: 1, type: 'failed', payload: JSON.stringify({ zeta: 1, alpha: long }) }],
      }),
    );
    // keys alphabetical: alpha before zeta
    expect(out).toMatch(/- #1 failed — alpha=x+…, zeta=1/);
    expect(out).not.toContain(long); // truncated
  });

  it('an unparseable fact payload degrades to a bounded raw digest rather than throwing', () => {
    const out = buildResumeFallbackSummary(
      baseInput({ facts: [{ seq: 1, type: 'failed', payload: 'not json' }] }),
    );
    expect(out).toContain('- #1 failed — not json');
  });

  it('accepts the store row types directly (structural assignability)', () => {
    const factRow: RunFactRow = { id: 9, runId: 1, attemptId: null, seq: 1, ts: 100, type: 'escalate', payload: '{"why":"x"}' };
    const eventRow: RunEventRow = { id: 8, runId: 1, seq: 1, ts: 100, type: 'lifecycle', payload: '{"event":"candidate"}' };
    const persisted: PersistedRunEvent = { id: 7, runId: 1, seq: 2, ts: 101, type: 'session_update', payload: { c: 1 } };
    const out = buildResumeFallbackSummary(
      baseInput({ facts: [factRow], events: [eventRow, persisted] }),
    );
    expect(out).toContain('- Terminal disposition: escalate');
    expect(out).toContain('- session_update: 1');
  });
});
