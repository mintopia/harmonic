import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Read as text: this suite runs under tsconfig.test.json, which has no DOM lib.
const PROCESS_TREE = readFileSync(
  fileURLToPath(new URL('../web/src/components/ProcessTree.tsx', import.meta.url)),
  'utf8',
);

const TABLE_VIEW = readFileSync(
  fileURLToPath(new URL('../web/src/components/TableView.tsx', import.meta.url)),
  'utf8',
);

describe('process tree idle rows retire whole-element opacity (issue #88)', () => {
  it('ProcessTree.tsx never uses an opacity-* utility for de-emphasis', () => {
    expect(PROCESS_TREE).not.toMatch(/opacity-/);
  });

  it('idle rows de-emphasise the node name via a colour-token step, not opacity', () => {
    expect(PROCESS_TREE).toContain("idle ? 'text-muted' : 'text-ink'");
    expect(PROCESS_TREE).toContain('text-ink');
    expect(PROCESS_TREE).toContain('text-muted');
  });
});

describe('task table stays free of whole-element opacity (issue #88, regression guard)', () => {
  it('TableView.tsx never uses an opacity-* utility for de-emphasis', () => {
    expect(TABLE_VIEW).not.toMatch(/opacity-/);
  });
});
