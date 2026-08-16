import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Idle rows must not be de-emphasised with whole-element opacity (issue #88).
 *
 * Whole-element `opacity-*` utilities multiply the real text colour below the
 * readable contrast floor — the process-tree idle-row dimming used to do
 * exactly that (`opacity-55` on the row button). This test reads the
 * component source straight from disk (no React import — this suite runs
 * under `tsconfig.test.json`, which has no DOM lib) and fails the build if an
 * `opacity-*` utility ever creeps back in, or if the idle name stops using a
 * colour-step (`text-ink` → `text-muted`) as its de-emphasis device.
 */

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
    // active rows keep text-ink; idle rows step down to text-muted (the
    // informational floor, AA-guaranteed by tests/contrast.test.ts).
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
