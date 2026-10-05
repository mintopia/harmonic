import { logger } from '../logger.js';
import type { Ticket, TrackerAdapter, TrackerRef } from './adapter.js';

/**
 * Completes an open-only scan with the closed tickets the mirror still needs: refs of non-terminal mirrored Tasks
 * (so an externally closed ticket still settles its Task), closed parents of scanned tickets, and previously persisted closed children of
 * scanned parents (so an open Epic whose members are all closed still derives as an Epic). Only parents are read remotely, so cost scales
 * with active Tasks and distinct parents, not total issues; closed tickets are cached until they reappear open.
 */
export class ClosedRefResolver {
  private readonly closed = new Map<TrackerRef, Ticket>();

  async complete(adapter: TrackerAdapter, scanned: Ticket[], activeMirroredRefs: Iterable<TrackerRef>, persisted: Ticket[] = []): Promise<Ticket[]> {
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
    const fetched = new Set(extra.map((t) => t.ref));
    for (const t of persisted) {
      if (t.parent !== null && scannedRefs.has(t.parent) && !scannedRefs.has(t.ref) && !fetched.has(t.ref)) extra.push({ ...t, state: 'closed' });
    }
    return extra.length === 0 ? scanned : [...scanned, ...extra];
  }
}
