import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../web/src/components/ticket/LifecycleTimeline.tsx', import.meta.url)),
  'utf8',
);
const TICKET_PAGE = readFileSync(fileURLToPath(new URL('../web/src/components/TicketPage.tsx', import.meta.url)), 'utf8');

describe('LifecycleTimeline', () => {
  it('is an explicitly chronological audit view, separate from the attempt selector', () => {
    expect(SOURCE).toContain('Chronological audit trail');
    expect(SOURCE).toContain('Chronological lifecycle timeline');
    expect(SOURCE).toContain('no selection controls');
    expect(TICKET_PAGE).toContain('<LifecycleTimeline');
    expect(TICKET_PAGE).toContain('api.taskTimeline(task.id)');
  });

  it('threads state-coloured nodes on a continuous connector rail with a time gutter', () => {
    // A continuous rail (each row's left border joins the next) with the node
    // punched over it by a canvas ring, and a dedicated time-gutter column.
    expect(SOURCE).toContain('border-l border-hairline');
    expect(SOURCE).toContain('ring-4 ring-canvas');
    expect(SOURCE).toContain('grid-cols-[54px_minmax(0,1fr)]');
    expect(SOURCE).toMatch(/clockTime|calendarDate/);
  });

  it('carries a sticky header bar with the shared follow/tail control', () => {
    expect(SOURCE).toContain('sticky top-0');
    expect(SOURCE).toContain('<FollowTail');
    expect(TICKET_PAGE).toContain('onToggleFollow');
  });
});
