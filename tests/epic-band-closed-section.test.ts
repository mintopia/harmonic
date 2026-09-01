import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract test (same approach as epic-integrate-held-surfacing.test.ts):
// Board.tsx carries JSX and can't be imported into the node test project, so the
// collapsible closed-tasks section (issue #423) is asserted against its source.
// The closed-member set itself is proven in epic-model.test.ts (closedMembers).
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('EpicBand collapsible closed-tasks section (issue #423)', () => {
  const board = source('web/src/components/Board.tsx');

  it('renders the closed members via a collapsible ClosedRail, only when there are any', () => {
    expect(board).toContain('const closed = closedMembers(epic);');
    expect(board).toContain('{closed.length > 0 && (');
    expect(board).toContain('<ClosedRail members={closed} onOpenTask={onOpenTask} collapsible />');
  });

  it('makes ClosedRail collapsible, collapsed by default, with a chevron disclosure', () => {
    expect(board).toContain('collapsible = false,');
    expect(board).toContain('const [open, setOpen] = useState(!collapsible);');
    expect(board).toContain('<Chevron open={open} />');
    expect(board).toContain('aria-expanded={open}');
  });

  it('renders each closed member as a full multi-row card, not a short row (issue #430)', () => {
    expect(board).toContain('w-[300px] shrink-0 rounded-lg border border-hairline bg-surface p-2.5');
    expect(board).not.toContain('w-[240px]');
    expect(board).toContain('mt-1 truncate text-small font-medium text-muted');
  });
});
