import { logger } from '../logger.js';
import type { Ticket, TrackerAdapter, TrackerRef } from './adapter.js';

/**
 * Completes an open-only scan with the closed tickets the mirror still needs: refs of non-terminal mirrored Tasks
 * (so an externally closed ticket still settles its Task) and closed parents of scanned tickets (so the Epic graph resolves).
 * Cost scales with active Tasks and distinct parents, not total issues; closed tickets are cached until they reappear open.
 */
export class ClosedRefResolver {
  private readonly closed = new Map<TrackerRef, Ticket>();

  async complete(adapter: TrackerAdapter, scanned: Ticket[], activeMirroredRefs: Iterable<TrackerRef>): Promise<Ticket[]> {
    if (!adapter.scansOpenOnly) return scanned;
    const scannedRefs = new Set(scanned.map((t) => t.ref));
    const wanted = new Set<TrackerRef>();
    for (const ref of activeMirroredRefs) if (!scannedRefs.has(ref)) wanted.add(ref);
    for (const t of scanned) if (t.parent !== null && !scannedRefs.has(t.parent)) wanted.add(t.parent);
    for (const ref of this.closed.keys()) if (!wanted.has(ref)) this.closed.delete(ref);
    const extra: Ticket[] = [];
    for (const ref of wanted) {
      let ticket = this.closed.get(ref);
      if (!ticket) {
        try {
          ticket = await adapter.readTicket({ ref, title: '', state: 'closed' });
        } catch (err) {
          logger.warn('tracker: could not read referenced ticket missing from the open scan', { ref, error: String(err) });
          continue;
        }
        if (ticket.state === 'closed') this.closed.set(ref, ticket);
      }
      extra.push(ticket);
    }
    return extra.length === 0 ? scanned : [...scanned, ...extra];
  }
}
