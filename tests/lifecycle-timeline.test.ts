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
    expect(TICKET_PAGE).toContain('<LifecycleTimeline events={timelineEvents} />');
    expect(TICKET_PAGE).toContain('api.taskTimeline(task.id)');
  });
});
