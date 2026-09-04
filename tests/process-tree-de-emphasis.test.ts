import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Read as text: this suite runs under tsconfig.test.json, which has no DOM lib.
const TABLE_VIEW = readFileSync(
  fileURLToPath(new URL('../web/src/components/TableView.tsx', import.meta.url)),
  'utf8',
);

describe('task table stays free of whole-element opacity (issue #88, regression guard)', () => {
  it('TableView.tsx never uses an opacity-* utility for de-emphasis', () => {
    expect(TABLE_VIEW).not.toMatch(/opacity-/);
  });
});
