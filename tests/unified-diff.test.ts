import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../src/domain/unified-diff.js';

describe('parseUnifiedDiff', () => {
  it('parses a modified file with correct path, status, counts, and line tracking', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc123..def456 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2 modified',
      '+line3 new',
      ' line4',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe('src/foo.ts');
    expect(file.status).toBe('M');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.lines).toEqual([
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -1,3 +1,4 @@' },
      { kind: 'context', oldLn: 1, newLn: 1, text: 'line1' },
      { kind: 'del', oldLn: 2, newLn: null, text: 'line2' },
      { kind: 'add', oldLn: null, newLn: 2, text: 'line2 modified' },
      { kind: 'add', oldLn: null, newLn: 3, text: 'line3 new' },
      { kind: 'context', oldLn: 3, newLn: 4, text: 'line4' },
    ]);
  });

  it('parses an added file with status A and path taken from the +++ side', () => {
    const raw = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..abc123',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line1',
      '+line2',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe('src/new.ts');
    expect(file.status).toBe('A');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.lines).toEqual([
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -0,0 +1,2 @@' },
      { kind: 'add', oldLn: null, newLn: 1, text: 'line1' },
      { kind: 'add', oldLn: null, newLn: 2, text: 'line2' },
    ]);
  });

  it('parses a deleted file with status D and path taken from the --- side', () => {
    const raw = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index abc123..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line1',
      '-line2',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe('src/old.ts');
    expect(file.status).toBe('D');
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(2);
    expect(file.lines).toEqual([
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -1,2 +0,0 @@' },
      { kind: 'del', oldLn: 1, newLn: null, text: 'line1' },
      { kind: 'del', oldLn: 2, newLn: null, text: 'line2' },
    ]);
  });

  it('parses multiple files in one diff into independent DiffFile entries', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc123..def456 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2 modified',
      '+line3 new',
      ' line4',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..abc123',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line1',
      '+line2',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(2);

    expect(files[0]!.path).toBe('src/foo.ts');
    expect(files[0]!.status).toBe('M');
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(1);

    expect(files[1]!.path).toBe('src/new.ts');
    expect(files[1]!.status).toBe('A');
    expect(files[1]!.additions).toBe(2);
    expect(files[1]!.deletions).toBe(0);
  });

  it('re-seeds oldLn/newLn from each hunk header when a file has multiple hunks', () => {
    const raw = [
      'diff --git a/src/multi.ts b/src/multi.ts',
      'index abc..def 100644',
      '--- a/src/multi.ts',
      '+++ b/src/multi.ts',
      '@@ -1,2 +1,2 @@',
      '-old1',
      '+new1',
      ' ctx1',
      '@@ -10,2 +10,3 @@',
      ' ctx2',
      '+added',
      '-removed',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(2);
    expect(file.lines).toEqual([
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -1,2 +1,2 @@' },
      { kind: 'del', oldLn: 1, newLn: null, text: 'old1' },
      { kind: 'add', oldLn: null, newLn: 1, text: 'new1' },
      { kind: 'context', oldLn: 2, newLn: 2, text: 'ctx1' },
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -10,2 +10,3 @@' },
      { kind: 'context', oldLn: 10, newLn: 10, text: 'ctx2' },
      { kind: 'add', oldLn: null, newLn: 11, text: 'added' },
      { kind: 'del', oldLn: 11, newLn: null, text: 'removed' },
    ]);
  });

  it('parses a hunk header without the ,count suffix (e.g. @@ -1 +1 @@)', () => {
    const raw = [
      'diff --git a/src/single.ts b/src/single.ts',
      'index abc..def 100644',
      '--- a/src/single.ts',
      '+++ b/src/single.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.lines).toEqual([
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -1 +1 @@' },
      { kind: 'del', oldLn: 1, newLn: null, text: 'old' },
      { kind: 'add', oldLn: null, newLn: 1, text: 'new' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('returns an empty array when there is no "diff --git" line', () => {
    const raw = ['this is not a diff', 'just some plain text', 'with no headers at all'].join('\n');
    expect(parseUnifiedDiff(raw)).toEqual([]);
  });

  it('ignores the "\\ No newline at end of file" marker line', () => {
    const raw = [
      'diff --git a/src/eof.ts b/src/eof.ts',
      'index abc..def 100644',
      '--- a/src/eof.ts',
      '+++ b/src/eof.ts',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.lines).toEqual([
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -1 +1 @@' },
      { kind: 'del', oldLn: 1, newLn: null, text: 'old' },
      { kind: 'add', oldLn: null, newLn: 1, text: 'new' },
    ]);
  });
});
