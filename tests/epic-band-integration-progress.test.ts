import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract test (same approach as epic-band-closed-section.test.ts):
// Board.tsx carries JSX and can't be imported into the node test project, so the
// whole-Epic integration progress in the band (issue #424) is asserted against
// its source. The step projection itself is proven in epic-model.test.ts
// (isEpicIntegrating / integrationSteps).
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('EpicBand whole-Epic integration progress (issue #424)', () => {
  const board = source('web/src/components/Board.tsx');

  it("makes the band's main content the IntegrationProgress bar while the Epic is integrating", () => {
    expect(board).toContain('{isEpicIntegrating(epic) && <IntegrationProgress epic={epic} />}');
  });

  it('drives the bar off the server-authoritative read model, never re-derived from child states', () => {
    // integrationSteps projects the DTO's verification/integrate fields (ADR-0011).
    expect(board).toContain('const steps = integrationSteps(epic);');
  });
});
