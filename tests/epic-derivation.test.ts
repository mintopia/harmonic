/**
 * Pure Epic-derivation tests (issue #158 / ADR-0024, ADR-0018). Table-style:
 * one `it` per case, exercising `deriveLeafEpics`/`deriveStoredEpics` directly
 * — no I/O, no fixtures beyond the `ticket()` builder below.
 */
import { describe, expect, it } from 'vitest';
import { deriveLeafEpics, deriveStoredEpics } from '../src/domain/epic-derivation.js';
import { EPIC_LABEL, type Ticket } from '../src/tracker/adapter.js';

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

/**
 * The integration-branch view: `deriveLeafEpics` selects the immediate-parent
 * container (leaf-most), not the top-level Epic — a distinct concern the
 * Epic-integration coordinator reads (issue #159/#334).
 */
describe('deriveLeafEpics', () => {
  const deriveLeaf = (tickets: Ticket[], unworkable: number[] = [], opts: { includeClosed?: boolean } = {}) => {
    const unworkableRefs = new Set(unworkable);
    return deriveLeafEpics(
      tickets,
      new Map(tickets.map((t) => [t.number, { agentWorkable: !unworkableRefs.has(t.number) }])),
      opts,
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

  it('a blocked member is a member but excluded from the ready frontier', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, blockedBy: [{ number: 11, title: 'x', state: 'open' }] }),
    ];
    const result = deriveLeaf(tickets, [12]);
    expect(result[0]?.members).toEqual([11, 12]);
    expect(result[0]?.ready).toEqual([11]);
  });

  it('an assigned-but-open member stays on the ready frontier', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, assignees: ['alice'] }),
    ];
    const result = deriveLeaf(tickets);
    expect(result[0]?.ready).toEqual([11, 12]);
  });

  it('a member that is not agent-workable is a member but never on the ready frontier', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10, labels: [] }),
      ticket({ number: 13, parent: 10, labels: ['needs-triage'] }),
    ];
    const result = deriveLeaf(tickets, [12, 13]);
    expect(result[0]?.members).toEqual([11, 12, 13]);
    expect(result[0]?.ready).toEqual([11]);
  });

  it('a closed leaf-most container yields nothing by default, but is derived with includeClosed', () => {
    const tickets = [
      ticket({ number: 10, title: 'Closed Spec', state: 'closed', closedAt: '2026-08-10T00:00:00Z' }),
      ticket({ number: 11, parent: 10 }),
    ];
    expect(deriveLeaf(tickets)).toEqual([]);
    const result = deriveLeaf(tickets, [], { includeClosed: true });
    expect(result).toEqual([{ ref: 10, title: 'Closed Spec', members: [11], ready: [11] }]);
  });
});

/**
 * The stored-Epic spine view (ADR-0018, #437): leaf-most **epic-type** containers
 * (a Map or an `epic`-labelled container) with the three-way stored `kind`. A
 * bare parent of work Tasks is deliberately excluded — it is not an Epic.
 */
describe('deriveStoredEpics', () => {
  it('Map: an isMap container is kind:"map"', () => {
    const tickets = [
      ticket({ number: 19, title: 'Map', isMap: true, labels: ['wayfinder:map'] }),
      ticket({ number: 20, parent: 19 }),
    ];
    expect(deriveStoredEpics(tickets)).toEqual([{ ref: 19, kind: 'map' }]);
  });

  it('Spec: an epic-labelled container with a non-empty body is kind:"spec"', () => {
    const tickets = [
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: '## What to build\n\nthe spec' }),
      ticket({ number: 11, parent: 10 }),
    ];
    expect(deriveStoredEpics(tickets)).toEqual([{ ref: 10, kind: 'spec' }]);
  });

  it('plain Epic: an epic-labelled container with an empty body is kind:"epic"', () => {
    const tickets = [
      ticket({ number: 10, title: 'Plain', labels: [EPIC_LABEL], body: '   \n  ' }),
      ticket({ number: 11, parent: 10 }),
    ];
    expect(deriveStoredEpics(tickets)).toEqual([{ ref: 10, kind: 'epic' }]);
  });

  it('a bare parent of work Tasks (no epic label, not a Map) is not a stored Epic', () => {
    const tickets = [
      ticket({ number: 10, title: 'Task with subtasks' }), // default labels: ['ready-for-agent']
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 12, parent: 10 }),
    ];
    expect(deriveStoredEpics(tickets)).toEqual([]);
  });

  it('selects the leaf-most epic-type container over a spine', () => {
    // #106 (epic) → #156 (epic, itself a container) → #157. #106 is a spine
    // (has a container child) and is suppressed; the leaf-most #156 is stored.
    const tickets = [
      ticket({ number: 106, title: 'Spine', labels: [EPIC_LABEL], body: 'top' }),
      ticket({ number: 156, title: 'Leaf-most', parent: 106, labels: [EPIC_LABEL], body: 'leaf spec' }),
      ticket({ number: 157, parent: 156 }),
    ];
    expect(deriveStoredEpics(tickets)).toEqual([{ ref: 156, kind: 'spec' }]);
  });

  it('a closed epic-type container is not stored (kind freezes only while live)', () => {
    const tickets = [
      ticket({ number: 10, title: 'Closed', state: 'closed', labels: [EPIC_LABEL], body: 'spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 20, title: 'Open', labels: [EPIC_LABEL], body: 'spec' }),
      ticket({ number: 21, parent: 20 }),
    ];
    expect(deriveStoredEpics(tickets)).toEqual([{ ref: 20, kind: 'spec' }]);
  });

  it('multiple stored Epics are sorted by ref ascending', () => {
    const tickets = [
      ticket({ number: 30, title: 'Map', isMap: true, labels: ['wayfinder:map'] }),
      ticket({ number: 31, parent: 30 }),
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: 'spec' }),
      ticket({ number: 11, parent: 10 }),
    ];
    expect(deriveStoredEpics(tickets).map((e) => e.ref)).toEqual([10, 30]);
  });
});
