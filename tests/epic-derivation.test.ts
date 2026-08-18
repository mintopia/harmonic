/**
 * Pure Epic-derivation tests (issue #158 / ADR-0024). Table-style: one `it`
 * per numbered case in the design spec, exercising `deriveEpics` directly —
 * no I/O, no fixtures beyond the `ticket()` builder below.
 */
import { describe, expect, it } from 'vitest';
import { deriveEpics } from '../src/domain/epic-derivation.js';
import { type Ticket } from '../src/tracker/adapter.js';

const ticket = (over: Partial<Ticket>): Ticket => ({
  number: 100,
  title: 'A ticket',
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: [],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/100',
  ...over,
});

describe('deriveEpics', () => {
  it('1. simple Spec: parent with two open, unassigned, unblocked children', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10 }),
    ];
    const result = deriveEpics(tickets);
    expect(result).toEqual([{ ref: 10, title: 'Spec', kind: 'spec', members: [11, 12], ready: [11, 12] }]);
  });

  it('2. Map: parent with isMap:true is kind:"map"', () => {
    const tickets = [
      ticket({ number: 19, title: 'Map', isMap: true, labels: ['wayfinder:map'] }),
      ticket({ number: 20, parent: 19 }),
      ticket({ number: 21, parent: 19 }),
    ];
    const result = deriveEpics(tickets);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('map');
  });

  it('3. blocked member: #12 blockedBy open #11, both children of #10', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 11, title: 'x', state: 'open' }] }),
    ];
    const result = deriveEpics(tickets);
    expect(result[0]?.members).toEqual([11, 12]);
    expect(result[0]?.ready).toEqual([11]);
  });

  it('4. blocker closed re-opens frontier', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10, state: 'closed' }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 11, title: 'x', state: 'closed' }] }),
    ];
    const result = deriveEpics(tickets);
    expect(result[0]?.members).toEqual([11, 12]);
    expect(result[0]?.ready).toEqual([12]);
  });

  it('5. assigned member excluded from ready', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, assignees: ['alice'] }),
    ];
    const result = deriveEpics(tickets);
    expect(result[0]?.ready).toEqual([11]);
  });

  it('6. leaf-most selection over a spine: only the leaf-most Epic is derived', () => {
    const tickets = [
      ticket({ number: 106, title: 'Spine parent' }),
      ticket({ number: 156, title: 'Leaf-most Epic', parent: 106 }),
      ticket({ number: 157, parent: 156 }),
      ticket({ number: 158, parent: 156 }),
    ];
    const result = deriveEpics(tickets);
    expect(result).toHaveLength(1);
    expect(result[0]?.ref).toBe(156);
    expect(result[0]?.members).toEqual([157, 158]);
  });

  it('7. Epic-parent-as-blocker ignored (containment, not a real blocker)', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 10, title: 'Spec', state: 'open' }] }),
    ];
    const result = deriveEpics(tickets);
    expect(result[0]?.ready).toEqual([11, 12]);
  });

  it('8. prose-only / no parent links yields no Epic, never throws', () => {
    const tickets = [ticket({ number: 1 }), ticket({ number: 2 })];
    expect(() => deriveEpics(tickets)).not.toThrow();
    expect(deriveEpics(tickets)).toEqual([]);
  });

  it('9. dangling parent (no matching ticket) is not derived, no throw', () => {
    const tickets = [ticket({ number: 1, parent: 999 })];
    expect(() => deriveEpics(tickets)).not.toThrow();
    expect(deriveEpics(tickets)).toEqual([]);
  });

  it('10. multiple leaf-most Epics in one scan, sorted by ref ascending', () => {
    const tickets = [
      ticket({ number: 20, title: 'Second Epic' }),
      ticket({ number: 21, parent: 20 }),
      ticket({ number: 10, title: 'First Epic' }),
      ticket({ number: 11, parent: 10 }),
    ];
    const result = deriveEpics(tickets);
    expect(result.map((e) => e.ref)).toEqual([10, 20]);
  });

  it('11. out-of-scan blocker uses the edge state', () => {
    const blocked = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 500, title: 'gone', state: 'open' }] }),
    ];
    expect(deriveEpics(blocked)[0]?.ready).toEqual([]);

    const unblocked = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 500, title: 'gone', state: 'closed' }] }),
    ];
    expect(deriveEpics(unblocked)[0]?.ready).toEqual([12]);
  });

  it('12. a node with one Epic child is a spine parent — the whole node is suppressed', () => {
    // #10 mixes a leaf Task (#12) with a sub-Epic (#11 → #99); the strict
    // leaf-most rule suppresses #10 entirely, so #12 is orphaned this pass and
    // only the genuinely leaf-most #11 is derived.
    const tickets = [
      ticket({ number: 10, title: 'Spine' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10 }),
      ticket({ number: 99, parent: 11 }),
    ];
    const result = deriveEpics(tickets);
    expect(result.map((e) => e.ref)).toEqual([11]);
    expect(result[0]?.members).toEqual([99]);
  });
});
