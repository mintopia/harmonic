import { logger } from '../logger.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { safeErrorReason } from './rest-client.js';
import type { Ticket, TrackerAdapter, TrackerRef } from './adapter.js';

const DEFAULT_FAILURE_RETRY_MS = 5 * 60_000;

/** Completes an open-only scan with the closed tickets the mirror still needs. */
export class ClosedRefResolver {
  private readonly closed = new Map<TrackerRef, Ticket>();
  /** Refs whose lookup failed, with when to try again; logged once until a lookup succeeds or the ref is no longer wanted. */
  private readonly failed = new Map<TrackerRef, number>();

  constructor(
    private readonly options: { failureRetryMs?: number; now?: () => number; yieldOptions?: YieldOptions } = {},
  ) {}

  async complete(adapter: TrackerAdapter, scanned: Ticket[], activeMirroredRefs: Iterable<TrackerRef>, persisted: Ticket[] = []): Promise<Ticket[]> {
    if (!adapter.scansOpenOnly) return scanned;
    const yieldOptions = this.options.yieldOptions;
    const now = this.options.now ?? Date.now;
    const scannedRefs = new Set<TrackerRef>();
    await forEachYielding(scanned, (t) => { scannedRefs.add(t.ref); }, yieldOptions);
    const wanted = new Set<TrackerRef>();
    await forEachYielding(activeMirroredRefs, (ref) => {
      if (!scannedRefs.has(ref)) wanted.add(ref);
    }, yieldOptions);
    await forEachYielding(scanned, (t) => {
      if (t.parent !== null && !scannedRefs.has(t.parent)) wanted.add(t.parent);
    }, yieldOptions);
    for (const ref of this.closed.keys()) if (!wanted.has(ref)) this.closed.delete(ref);
    for (const ref of this.failed.keys()) if (!wanted.has(ref)) this.failed.delete(ref);
    const extra: Ticket[] = [];
    await forEachYielding(wanted, async (ref) => {
      let ticket = this.closed.get(ref);
      if (!ticket) {
        const retryAt = this.failed.get(ref);
        if (retryAt !== undefined && now() < retryAt) return;
        try {
          ticket = await adapter.readTicket({ ref, title: '', state: 'closed' });
        } catch (err) {
          if (retryAt === undefined) {
            logger.warn('tracker: could not read referenced ticket missing from the open scan', { ref, error: safeErrorReason(err) });
          }
          this.failed.set(ref, now() + (this.options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS));
          return;
        }
        this.failed.delete(ref);
        if (ticket.state === 'closed') this.closed.set(ref, ticket);
      }
      extra.push(ticket);
    }, yieldOptions);
    const fetched = new Set<TrackerRef>();
    await forEachYielding(extra, (t) => { fetched.add(t.ref); }, yieldOptions);
    await forEachYielding(persisted, (t) => {
      if (t.parent !== null && scannedRefs.has(t.parent) && !scannedRefs.has(t.ref) && !fetched.has(t.ref)) extra.push({ ...t, state: 'closed' });
    }, yieldOptions);
    return extra.length === 0 ? scanned : [...scanned, ...extra];
  }
}
