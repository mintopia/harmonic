import { describe, expect, it } from 'vitest';
import { toolDiffFile } from '../web/src/tool-diff.js';

describe('toolDiffFile', () => {
  it('retains shared context and counts only changed lines', () => {
    expect(toolDiffFile({ path: 'src/app.ts', oldText: 'keep\nbefore\nend\n', newText: 'keep\nafter\nend\n' })).toMatchObject({
      additions: 1,
      deletions: 1,
      lines: [
        { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
        { kind: 'context', oldLn: 1, newLn: 1, text: 'keep' },
        { kind: 'del', oldLn: 2, newLn: null, text: 'before' },
        { kind: 'add', oldLn: null, newLn: 2, text: 'after' },
        { kind: 'context', oldLn: 3, newLn: 3, text: 'end' },
      ],
    });
  });

  it('keeps context between separate changes', () => {
    expect(toolDiffFile({ path: 'src/app.ts', oldText: 'a\nb\nc\nd\ne\n', newText: 'a\nx\nc\ny\ne\n' })).toMatchObject({
      additions: 2,
      deletions: 2,
      lines: [
        { kind: 'hunk', text: '@@ -1,5 +1,5 @@' },
        { kind: 'context', text: 'a' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'x' },
        { kind: 'context', text: 'c' },
        { kind: 'del', text: 'd' },
        { kind: 'add', text: 'y' },
        { kind: 'context', text: 'e' },
      ],
    });
  });

  it('bounds line comparison for large snapshots', () => {
    const oldText = `${Array.from({ length: 500 }, (_, index) => `old-${index}`).join('\n')}\n`;
    const newText = `${Array.from({ length: 500 }, (_, index) => `new-${index}`).join('\n')}\n`;

    expect(toolDiffFile({ path: 'large.ts', oldText, newText })).toMatchObject({ additions: 500, deletions: 500 });
  });
});
