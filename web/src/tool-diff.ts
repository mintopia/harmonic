import type { DiffFile, DiffLine } from './types.js';
import type { ToolDiff } from './event-stream-model.js';

const MAX_LCS_CELLS = 250_000;

function lines(text: string): string[] {
  if (text === '') return [];
  const split = text.split('\n');
  return split.at(-1) === '' ? split.slice(0, -1) : split;
}

function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  if ((oldLines.length + 1) * (newLines.length + 1) > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((text, index): DiffLine => ({ kind: 'del', oldLn: index + 1, newLn: null, text })),
      ...newLines.map((text, index): DiffLine => ({ kind: 'add', oldLn: null, newLn: index + 1, text })),
    ];
  }
  const width = newLines.length + 1;
  const scores = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const oldLine = oldLines[oldIndex];
      const newLine = newLines[newIndex];
      if (oldLine === undefined || newLine === undefined) continue;
      const index = oldIndex * width + newIndex;
      scores[index] = oldLine === newLine
        ? (scores[(oldIndex + 1) * width + newIndex + 1] ?? 0) + 1
        : Math.max(scores[(oldIndex + 1) * width + newIndex] ?? 0, scores[oldIndex * width + newIndex + 1] ?? 0);
    }
  }

  const result: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];
    if (oldLine === undefined && newLine !== undefined) {
      result.push({ kind: 'add', oldLn: null, newLn: newIndex + 1, text: newLine });
      newIndex++;
    } else if (newLine === undefined && oldLine !== undefined) {
      result.push({ kind: 'del', oldLn: oldIndex + 1, newLn: null, text: oldLine });
      oldIndex++;
    } else if (oldLine === undefined || newLine === undefined) {
      break;
    } else if (oldLine === newLine) {
      result.push({ kind: 'context', oldLn: oldIndex + 1, newLn: newIndex + 1, text: oldLine });
      oldIndex++;
      newIndex++;
    } else if ((scores[(oldIndex + 1) * width + newIndex] ?? 0) >= (scores[oldIndex * width + newIndex + 1] ?? 0)) {
      result.push({ kind: 'del', oldLn: oldIndex + 1, newLn: null, text: oldLine });
      oldIndex++;
    } else {
      result.push({ kind: 'add', oldLn: null, newLn: newIndex + 1, text: newLine });
      newIndex++;
    }
  }
  return result;
}

export function toolDiffFile(diff: ToolDiff): DiffFile {
  const oldLines = lines(diff.oldText ?? '');
  const newLines = lines(diff.newText);
  const changedLines = diffLines(oldLines, newLines);
  const status = oldLines.length === 0 ? 'A' : newLines.length === 0 ? 'D' : 'M';
  const hunk: DiffLine = {
    kind: 'hunk',
    oldLn: null,
    newLn: null,
    text: `@@ -${oldLines.length === 0 ? 0 : 1},${oldLines.length} +${newLines.length === 0 ? 0 : 1},${newLines.length} @@`,
  };
  return {
    path: diff.path || 'File',
    status,
    additions: changedLines.filter(({ kind }) => kind === 'add').length,
    deletions: changedLines.filter(({ kind }) => kind === 'del').length,
    lines: [hunk, ...changedLines],
  };
}
