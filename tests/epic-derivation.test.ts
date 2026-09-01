/**
 * Pure Epic-derivation tests (issue #158 / ADR-0024). Table-style: one `it`
 * per numbered case in the design spec, exercising `deriveEpics` directly —
 * no I/O, no fixtures beyond the `ticket()` builder below.
 */
import { describe, expect, it } from 'vitest';
import { deriveEpics, deriveLeafEpics } from '../src/domain/epic-derivation.js';
import { type Ticket } from '../src/tracker/adapter.js';

const ticket = (over: Partial<Ticket>): Ticket => ({
  number: 100,
  title: 'A ticket',
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: ['ready-for-agent'],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: 'https://github.com/mintopia/harmonic/issues/100',
  ...over,
});

/** The Task-layer readiness facts are intentionally separate from tracker tickets. */
const derive = (tickets: Ticket[], unworkable: number[] = [], opts: { includeClosed?: boolean } = {}) => {
  const unworkableRefs = new Set(unworkable);
  return deriveEpics(
    tickets,
    new Map(tickets.map((ticket) => [ticket.number, { agentWorkable: !unworkableRefs.has(ticket.number) }])),
    opts,
  );
};

describe('deriveEpics', () => {
  it('1. simple Spec: parent with two open, unassigned, unblocked children', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10 }),
    ];
    const result = derive(tickets);
    expect(result).toEqual([{ ref: 10, title: 'Spec', kind: 'spec', members: [11, 12], ready: [11, 12] }]);
  });

  it('2. Map: parent with isMap:true is kind:"map"', () => {
    const tickets = [
      ticket({ number: 19, title: 'Map', isMap: true, labels: ['wayfinder:map'] }),
      ticket({ number: 20, parent: 19 }),
      ticket({ number: 21, parent: 19 }),
    ];
    const result = derive(tickets);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('map');
  });

  it('3. blocked member: #12 blockedBy open #11, both children of #10', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 11, title: 'x', state: 'open' }] }),
    ];
    const result = derive(tickets, [12]);
    expect(result[0]?.members).toEqual([11, 12]);
    expect(result[0]?.ready).toEqual([11]);
  });

  it('4. blocker closed re-opens frontier', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10, state: 'closed' }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 11, title: 'x', state: 'closed' }] }),
    ];
    const result = derive(tickets);
    expect(result[0]?.members).toEqual([11, 12]);
    expect(result[0]?.ready).toEqual([12]);
  });

  it('5. assigned ready-for-agent member stays on the ready frontier', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, assignees: ['alice'] }),
    ];
    const result = derive(tickets);
    expect(result[0]?.ready).toEqual([11, 12]);
  });

  it('6. top-level selection over a spine: the top-level container is the Epic, sub-container leaves roll up', () => {
    const tickets = [
      ticket({ number: 106, title: 'Top-level Epic' }),
      ticket({ number: 156, title: 'Sub-container', parent: 106 }),
      ticket({ number: 157, parent: 156 }),
      ticket({ number: 158, parent: 156 }),
    ];
    const result = derive(tickets);
    expect(result).toHaveLength(1);
    expect(result[0]?.ref).toBe(106);
    // #156 is a nested sub-container (has a parent); its leaves roll up to #106.
    expect(result[0]?.members).toEqual([157, 158]);
  });

  it('7. Epic-parent-as-blocker ignored (containment, not a real blocker)', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 10, title: 'Spec', state: 'open' }] }),
    ];
    const result = derive(tickets);
    expect(result[0]?.ready).toEqual([11, 12]);
  });

  it('8. prose-only / no parent links yields no Epic, never throws', () => {
    const tickets = [ticket({ number: 1 }), ticket({ number: 2 })];
    expect(() => derive(tickets)).not.toThrow();
    expect(derive(tickets)).toEqual([]);
  });

  it('9. dangling parent (no matching ticket) is not derived, no throw', () => {
    const tickets = [ticket({ number: 1, parent: 999 })];
    expect(() => derive(tickets)).not.toThrow();
    expect(derive(tickets)).toEqual([]);
  });

  it('10. multiple top-level Epics in one scan, sorted by ref ascending', () => {
    const tickets = [
      ticket({ number: 20, title: 'Second Epic' }),
      ticket({ number: 21, parent: 20 }),
      ticket({ number: 10, title: 'First Epic' }),
      ticket({ number: 11, parent: 10 }),
    ];
    const result = derive(tickets);
    expect(result.map((e) => e.ref)).toEqual([10, 20]);
  });

  it('11. out-of-scan blocker uses the edge state', () => {
    const blocked = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 500, title: 'gone', state: 'open' }] }),
    ];
    expect(derive(blocked, [12])[0]?.ready).toEqual([]);

    const unblocked = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 500, title: 'gone', state: 'closed' }] }),
    ];
    expect(derive(unblocked)[0]?.ready).toEqual([12]);
  });

  it('12. a top-level node mixing a leaf Task with a sub-container rolls every leaf up to itself', () => {
    // #10 mixes a leaf Task (#12) with a sub-container (#11 → #99). Under the
    // top-level rule #10 is the sole Epic and both leaves — the direct #12 and
    // the nested #99 — roll up to it; #11 (a sub-container) is not surfaced and
    // #12 is no longer orphaned.
    const tickets = [
      ticket({ number: 10, title: 'Top-level Epic' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10 }),
      ticket({ number: 99, parent: 11 }),
    ];
    const result = derive(tickets);
    expect(result.map((e) => e.ref)).toEqual([10]);
    expect(result[0]?.members).toEqual([12, 99]);
  });

  it('13. closed Epic is not derived, but still counts as containment for members', () => {
    const tickets = [
      // #10 is a closed, finished Epic with a child (so #10 is in epicRefs).
      ticket({ number: 10, title: 'Closed Spec', state: 'closed', closedAt: '2026-08-10T00:00:00Z' }),
      ticket({ number: 11, parent: 10 }),
      // #20 is an open sibling Epic of the same shape — still derived.
      ticket({ number: 20, title: 'Open Spec' }),
      // #21 is blocked only by the closed Epic ref #10. That ref is containment
      // (not a real dependency), so #21 is still ready — proving #10 was NOT
      // removed from epicRefs when it was skipped as a derived Epic.
      ticket({ number: 21, parent: 20, blockedBy: [{ number: 10, title: 'Closed Spec', state: 'closed' }] }),
    ];
    const result = derive(tickets);
    // The closed Epic is absent; only the open sibling is derived.
    expect(result.map((e) => e.ref)).toEqual([20]);
    // Containment holds: #21 stays on the ready frontier.
    expect(result.find((e) => e.ref === 20)?.ready).toEqual([21]);
  });

  it('14. a member that is not agent-workable is a member but never on the ready frontier', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }), // ready-for-agent (builder default)
      ticket({ number: 12, parent: 10, labels: [] }), // no opt-in — not auto-runnable
      ticket({ number: 13, parent: 10, labels: ['needs-triage'] }), // some other label, still no opt-in
    ];
    const result = derive(tickets, [12, 13]);
    expect(result[0]?.members).toEqual([11, 12, 13]);
    expect(result[0]?.ready).toEqual([11]);
  });

  it('15. ADR-0016: only the top-level container is an Epic; a sub-parent (parent WITH a parent) is not', () => {
    // #1 (top) → #2 (sub-container) → #3 (sub-container) → #4 (leaf). Only #1 is
    // an Epic; #2 and #3 both have a parent, so neither is surfaced, and the one
    // leaf #4 rolls all the way up to #1.
    const tickets = [
      ticket({ number: 1, title: 'Top-level Epic' }),
      ticket({ number: 2, parent: 1 }),
      ticket({ number: 3, parent: 2 }),
      ticket({ number: 4, parent: 3 }),
    ];
    const result = derive(tickets);
    expect(result.map((e) => e.ref)).toEqual([1]);
    expect(result[0]?.members).toEqual([4]);
  });

  it('16. includeClosed opt-in surfaces a closed Epic for the detail read path', () => {
    const tickets = [
      // #10 is a closed, finished Epic with a child.
      ticket({ number: 10, title: 'Closed Spec', state: 'closed', closedAt: '2026-08-10T00:00:00Z' }),
      ticket({ number: 11, parent: 10 }),
      // #20 is an open sibling Epic of the same shape.
      ticket({ number: 20, title: 'Open Spec' }),
      ticket({ number: 21, parent: 20 }),
    ];
    const result = derive(tickets, [], { includeClosed: true });
    expect(result.map((e) => e.ref)).toEqual([10, 20]);
    expect(result.find((e) => e.ref === 10)?.members).toEqual([11]);
  });
});

/**
 * The integration-branch view: `deriveLeafEpics` selects the immediate-parent
 * container (leaf-most), not the top-level Epic — a distinct concern the
 * Epic-integration coordinator reads (issue #159/#334).
 */
describe('deriveLeafEpics', () => {
  const deriveLeaf = (tickets: Ticket[], unworkable: number[] = []) => {
    const unworkableRefs = new Set(unworkable);
    return deriveLeafEpics(
      tickets,
      new Map(tickets.map((t) => [t.number, { agentWorkable: !unworkableRefs.has(t.number) }])),
    );
  };

  it('selects the leaf-most container over a spine, with its direct children as members', () => {
    // #106 (top) → #156 (leaf-most) → #157, #158. The leaf-most #156 is derived,
    // not the top-level #106; members are #156's direct children.
    const tickets = [
      ticket({ number: 106, title: 'Top-level' }),
      ticket({ number: 156, title: 'Leaf-most', parent: 106 }),
      ticket({ number: 157, parent: 156 }),
      ticket({ number: 158, parent: 156 }),
    ];
    const result = deriveLeaf(tickets);
    expect(result).toHaveLength(1);
    expect(result[0]?.ref).toBe(156);
    expect(result[0]?.members).toEqual([157, 158]);
  });

  it('suppresses a mixed spine parent (a leaf child beside a sub-container)', () => {
    // #10 mixes a leaf (#12) with a sub-container (#11 → #99): a spine parent,
    // suppressed. Only the genuinely leaf-most #11 is derived, so #12 is orphaned
    // this pass — the pre-ADR-0016 behavior the coordinator still relies on.
    const tickets = [
      ticket({ number: 10, title: 'Spine' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10 }),
      ticket({ number: 99, parent: 11 }),
    ];
    const result = deriveLeaf(tickets);
    expect(result.map((e) => e.ref)).toEqual([11]);
    expect(result[0]?.members).toEqual([99]);
  });
});
