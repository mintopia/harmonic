import { describe, expect, it } from 'vitest';
import { RUN_PHASES, nextPhase, phasePath, type RunPhase } from '../src/domain/run-phases.js';

describe('nextPhase (issue #114, linear since ADR-0041 removed the review gate)', () => {
  it('executing -> validating', () => {
    expect(nextPhase('executing')).toBe('validating');
  });

  it('validating -> verifying', () => {
    expect(nextPhase('validating')).toBe('verifying');
  });

  it('verifying -> landing (no human gate in between)', () => {
    expect(nextPhase('verifying')).toBe('landing');
  });

  it('landing -> terminal', () => {
    expect(nextPhase('landing')).toBe('terminal');
  });

  it('terminal -> null (the sink, no forward transition)', () => {
    expect(nextPhase('terminal')).toBeNull();
  });

  it('has no review phase at all', () => {
    expect((RUN_PHASES as readonly string[]).includes('review')).toBe(false);
  });

  it('is total over every RunPhase (always returns, never throws) and never revisits a phase', () => {
    const seen = new Set<RunPhase>();
    for (const phase of RUN_PHASES) {
      expect(() => nextPhase(phase)).not.toThrow();
      const next = nextPhase(phase);
      if (next !== null) {
        expect(seen.has(next)).toBe(false);
        seen.add(next);
      }
    }
  });
});

describe('phasePath (issue #114)', () => {
  it('executing -> landing collects every intermediate phase', () => {
    expect(phasePath('executing', 'landing')).toEqual(['validating', 'verifying', 'landing']);
  });

  it('executing -> terminal walks the whole chain', () => {
    expect(phasePath('executing', 'terminal')).toEqual(['validating', 'verifying', 'landing', 'terminal']);
  });

  it('verifying -> terminal is just the tail of the chain', () => {
    expect(phasePath('verifying', 'terminal')).toEqual(['landing', 'terminal']);
  });

  it('a phase to itself is never reachable (the machine is acyclic)', () => {
    expect(phasePath('verifying', 'verifying')).toEqual([]);
  });

  it('a backward hop is unreachable', () => {
    expect(phasePath('landing', 'executing')).toEqual([]);
  });

  it('terminal has no forward path to anything, including itself', () => {
    expect(phasePath('terminal', 'terminal')).toEqual([]);
    expect(phasePath('terminal', 'executing')).toEqual([]);
  });

  it('a single-step hop returns exactly the one next phase', () => {
    expect(phasePath('executing', 'validating')).toEqual(['validating']);
    expect(phasePath('verifying', 'landing')).toEqual(['landing']);
  });
});
