import { describe, expect, it } from 'vitest';
import {
  RUN_PHASES,
  PARKED_PHASES,
  nextPhase,
  phasePath,
  isParkedPhase,
  type RunPhase,
} from '../src/domain/run-phases.js';

describe('nextPhase (issue #114)', () => {
  describe('gate-independent transitions (same successor under both gates)', () => {
    it('executing -> validating', () => {
      expect(nextPhase('executing', 'human')).toBe('validating');
      expect(nextPhase('executing', 'auto')).toBe('validating');
    });

    it('validating -> verifying', () => {
      expect(nextPhase('validating', 'human')).toBe('verifying');
      expect(nextPhase('validating', 'auto')).toBe('verifying');
    });

    it('review -> landing', () => {
      expect(nextPhase('review', 'human')).toBe('landing');
      expect(nextPhase('review', 'auto')).toBe('landing');
    });

    it('landing -> terminal', () => {
      expect(nextPhase('landing', 'human')).toBe('terminal');
      expect(nextPhase('landing', 'auto')).toBe('terminal');
    });

    it('terminal -> null (the sink, no forward transition)', () => {
      expect(nextPhase('terminal', 'human')).toBeNull();
      expect(nextPhase('terminal', 'auto')).toBeNull();
    });
  });

  describe('the verifying branch (the ONE fork in the machine)', () => {
    it('human gate: verifying -> review', () => {
      expect(nextPhase('verifying', 'human')).toBe('review');
    });

    it('auto gate: verifying -> landing (review skipped)', () => {
      expect(nextPhase('verifying', 'auto')).toBe('landing');
    });
  });

  it('is total over every RunPhase under both gates (always returns, never throws)', () => {
    for (const phase of RUN_PHASES) {
      for (const gate of ['human', 'auto'] as const) {
        expect(() => nextPhase(phase, gate)).not.toThrow();
      }
    }
  });
});

describe('phasePath (issue #114)', () => {
  it("executing -> review under 'human' collects every intermediate phase", () => {
    expect(phasePath('executing', 'review', 'human')).toEqual(['validating', 'verifying', 'review']);
  });

  it("executing -> terminal under 'auto' skips review entirely", () => {
    expect(phasePath('executing', 'terminal', 'auto')).toEqual(['validating', 'verifying', 'landing', 'terminal']);
  });

  it("review -> terminal under 'human' is just the tail of the chain", () => {
    expect(phasePath('review', 'terminal', 'human')).toEqual(['landing', 'terminal']);
  });

  it("executing -> review under 'auto' is unreachable (auto never visits review)", () => {
    expect(phasePath('executing', 'review', 'auto')).toEqual([]);
  });

  it('a phase to itself is never reachable (the machine is acyclic)', () => {
    expect(phasePath('verifying', 'verifying', 'human')).toEqual([]);
  });

  it('terminal has no forward path to anything, including itself', () => {
    expect(phasePath('terminal', 'terminal', 'human')).toEqual([]);
    expect(phasePath('terminal', 'executing', 'auto')).toEqual([]);
  });

  it('a single-step hop returns exactly the one next phase', () => {
    expect(phasePath('executing', 'validating', 'human')).toEqual(['validating']);
    expect(phasePath('verifying', 'landing', 'auto')).toEqual(['landing']);
  });

  it("verifying -> landing under 'human' passes through review on the way (forward-reachable, not direct)", () => {
    expect(phasePath('verifying', 'landing', 'human')).toEqual(['review', 'landing']);
  });
});

describe('isParkedPhase (issue #114)', () => {
  it('is true for review (the only phase with no live process by design)', () => {
    expect(isParkedPhase('review')).toBe(true);
  });

  it('is false for every other phase', () => {
    const nonParked = RUN_PHASES.filter((p): p is Exclude<RunPhase, (typeof PARKED_PHASES)[number]> =>
      !(PARKED_PHASES as readonly string[]).includes(p),
    );
    for (const phase of nonParked) {
      expect(isParkedPhase(phase)).toBe(false);
    }
  });

  it('is false for null and undefined (no phase recorded yet is not "parked")', () => {
    expect(isParkedPhase(null)).toBe(false);
    expect(isParkedPhase(undefined)).toBe(false);
  });

  it('PARKED_PHASES is exactly [review] (locked set, issue #114)', () => {
    expect(PARKED_PHASES).toEqual(['review']);
  });
});
