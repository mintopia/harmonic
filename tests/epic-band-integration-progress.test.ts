import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Board.tsx carries JSX and can't be imported into the node test project.
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function componentBody(board: string, name: string): string {
  const start = board.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`component ${name} not found in Board.tsx`);
  const rest = board.slice(start + `function ${name}(`.length);
  const nextIdx = rest.search(/\nfunction [A-Za-z]/);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

describe('EpicBand whole-Epic integration progress (issue #424)', () => {
  const board = source('web/src/components/Board.tsx');
  const epicBand = componentBody(board, 'EpicBand');

  it("makes the main-board band's content the shared integration bar while the Epic is integrating", () => {
    expect(epicBand).toContain('{isEpicIntegrating(epic) && <EpicIntegrationBar epic={epic} />}');
  });

  it('drives the bar off the server-authoritative read model, never re-derived from child states', () => {
    const bar = source('web/src/components/EpicIntegrationBar.tsx');
    expect(bar).toContain('const steps = integrationSteps(epic);');
  });
});
