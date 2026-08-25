import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(import.meta.dirname, '..', 'src');
const consolePattern = /\bconsole\.[A-Za-z_$][\w$]*/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      yield* sourceFiles(filePath);
      continue;
    }
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      yield filePath;
    }
  }
}

describe('src logging retrofit', () => {
  it('keeps raw console calls out of src', () => {
    const offenders = [...sourceFiles(srcRoot)].flatMap((filePath) => {
      const lines = readFileSync(filePath, 'utf8').split('\n');
      return lines.flatMap((line, index) =>
        consolePattern.test(line) ? [`${relative(srcRoot, filePath)}:${index + 1}:${line.trim()}`] : [],
      );
    });

    expect(offenders).toEqual([]);
  });
});
