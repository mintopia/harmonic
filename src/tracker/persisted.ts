import type { TaskRow, TrackerContainerRow, TrackerFacts } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import { MAP_LABEL, type Ticket } from './adapter.js';

type StoredFacts = Pick<
  TaskRow,
  | 'trackerState'
  | 'trackerParent'
  | 'trackerBlockedBy'
  | 'trackerLabels'
  | 'trackerTitle'
  | 'trackerBody'
  | 'trackerUrl'
  | 'trackerCreatedAt'
>;

function factsFrom(row: StoredFacts): TrackerFacts | null {
  if (
    row.trackerState === null ||
    row.trackerBlockedBy === null ||
    row.trackerLabels === null ||
    row.trackerTitle === null ||
    row.trackerBody === null ||
    row.trackerUrl === null ||
    row.trackerCreatedAt === null
  ) return null;
  return {
    state: row.trackerState,
    parent: row.trackerParent,
    blockedBy: row.trackerBlockedBy,
    labels: row.trackerLabels,
    title: row.trackerTitle,
    body: row.trackerBody,
    url: row.trackerUrl,
    createdAt: row.trackerCreatedAt,
  };
}

function ticketFrom(number: number, facts: TrackerFacts, isMap: boolean): Ticket {
  return {
    number,
    ...facts,
    isMap,
    closedAt: null,
    assignees: [],
    blocking: [],
    comments: [],
  };
}

/** Rebuild normalised tickets from the DB, yielding as the persisted workload grows. */
export async function persistedTickets(rows: TaskRow[], containers: TrackerContainerRow[]): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  await forEachYielding(rows, (row) => {
    const facts = factsFrom(row);
    if (row.origin === 'mirrored' && row.trackerRef !== null && facts) {
      tickets.push(ticketFrom(row.trackerRef, facts, false));
    }
  });
  await forEachYielding(containers, (row) => {
    const facts = factsFrom(row);
    if (facts) tickets.push(ticketFrom(row.trackerRef, facts, facts.labels.includes(MAP_LABEL)));
  });
  return tickets;
}
