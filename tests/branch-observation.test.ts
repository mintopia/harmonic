import { describe, it, expect } from 'vitest';
import { parseRefLines, ownedRefRunId, diffRefs } from '../src/domain/branch-observation.js';

describe('branch-observation: parseRefLines (issue #151)', () => {
  it('parses `oid ref` lines into a snapshot, keeping only heads + harmonic refs', () => {
    const out = [
      'aaaa refs/heads/main',
      'bbbb refs/heads/feature',
      'cccc refs/harmonic/direct/run-3',
      'dddd refs/remotes/origin/main', // dropped — not contract-relevant
      'eeee refs/tags/v1', // dropped
      'ffff refs/stash', // dropped
    ].join('\n');
    expect(parseRefLines(out)).toEqual({
      'refs/heads/main': 'aaaa',
      'refs/heads/feature': 'bbbb',
      'refs/harmonic/direct/run-3': 'cccc',
    });
  });

  it('ignores blank lines and malformed rows, so an empty repo yields {}', () => {
    expect(parseRefLines('')).toEqual({});
    expect(parseRefLines('\n  \nnope-no-space\n')).toEqual({});
  });
});

describe('branch-observation: ownedRefRunId (issue #151)', () => {
  it('extracts the run id from a `refs/harmonic/<purpose>/run-<id>` ref', () => {
    expect(ownedRefRunId('refs/harmonic/direct/run-42')).toBe(42);
    expect(ownedRefRunId('refs/harmonic/candidate/run-7')).toBe(7);
  });

  it('returns null for a non-Harmonic ref, or a Harmonic ref without a numeric run id', () => {
    expect(ownedRefRunId('refs/heads/main')).toBeNull();
    expect(ownedRefRunId('refs/tags/v1')).toBeNull();
    expect(ownedRefRunId('refs/harmonic/direct/run-abc')).toBeNull();
    expect(ownedRefRunId('refs/harmonic/direct/branch-1')).toBeNull();
  });
});

describe('branch-observation: diffRefs (issue #151)', () => {
  it('omits unchanged refs and reports a created ref (from: null) as unattributed', () => {
    const before = { 'refs/heads/main': 'S' };
    const after = { 'refs/heads/main': 'S', 'refs/heads/stray': 'F' };
    expect(diffRefs(before, after)).toEqual([
      { ref: 'refs/heads/stray', from: null, to: 'F', attributedRunId: null },
    ]);
  });

  it('reports a deleted ref (to: null) and a moved ref', () => {
    const before = { 'refs/heads/main': 'S', 'refs/heads/gone': 'G' };
    const after = { 'refs/heads/main': 'M' };
    expect(diffRefs(before, after)).toEqual([
      { ref: 'refs/heads/gone', from: 'G', to: null, attributedRunId: null },
      { ref: 'refs/heads/main', from: 'S', to: 'M', attributedRunId: null },
    ]);
  });

  it('attributes a Harmonic ref to the run id in its name (this run vs a foreign run)', () => {
    const before = {};
    const after = {
      'refs/harmonic/direct/run-9': 'A',
      'refs/harmonic/candidate/run-9': 'C',
      'refs/harmonic/direct/run-8': 'B', // a different run's ref → foreign
    };
    const deltas = diffRefs(before, after);
    expect(deltas).toEqual([
      { ref: 'refs/harmonic/candidate/run-9', from: null, to: 'C', attributedRunId: 9 },
      { ref: 'refs/harmonic/direct/run-8', from: null, to: 'B', attributedRunId: 8 },
      { ref: 'refs/harmonic/direct/run-9', from: null, to: 'A', attributedRunId: 9 },
    ]);
  });

  it('is stable: deltas come back sorted by ref name', () => {
    const before = {};
    const after = { 'refs/heads/z': '1', 'refs/heads/a': '2', 'refs/harmonic/direct/run-1': '3' };
    expect(diffRefs(before, after).map((d) => d.ref)).toEqual([
      'refs/harmonic/direct/run-1',
      'refs/heads/a',
      'refs/heads/z',
    ]);
  });
});
