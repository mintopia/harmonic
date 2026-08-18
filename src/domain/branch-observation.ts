/**
 * Build the branch-contract observation the classifier consumes (issue #151,
 * reliability-design Unit D). `classifyBranchOutcome` (issue #150,
 * domain/branch-recovery.ts) is the **pure decision**; this module is the pure
 * **ref-delta + attribution** half that turns two ref snapshots — one recorded
 * at Run start (issue #149's `run-start-state` fact), one read at `validating` —
 * into the `RefDelta[]` the decision needs. Kept git-free and database-free (the
 * same seam as `run-disposition.ts`): the Runner reads the raw ref lines via
 * `Git.forEachRef` and feeds them here, so every attribution rule is exhaustively
 * unit-testable from plain fixtures.
 *
 * **Attribution is by naming convention**, not a general owned-ref tracker
 * (deferred): Harmonic only ever moves its own `refs/harmonic/<purpose>/run-<id>`
 * refs during a Run (the private direct ref of issue #152 and the candidate ref
 * of issue #134), and it detaches HEAD rather than touching the live target
 * branch. So a moved ref is attributed to the Run id embedded in its
 * `refs/harmonic/.../run-<id>` name; anything else — a moved `refs/heads/*`
 * branch, a stray branch the agent created — is **unattributed** (`null`), which
 * the classifier treats as an ambiguous contract break.
 */

import type { RefDelta } from './branch-recovery.js';

/** A ref snapshot: full ref name → the OID it points at. */
export type RefSnapshot = Record<string, string>;

/**
 * The ref namespaces the branch contract reasons about: local branches (where a
 * stray-branch / moved-target violation shows up) and Harmonic's own refs (the
 * attributed direct/candidate refs). Remote-tracking refs, tags, and stash are
 * deliberately excluded — they are not part of the "Harmonic owns branching"
 * contract and a fetch moving a `refs/remotes/*` ref must not read as a violation.
 */
function isRelevantRef(ref: string): boolean {
  return ref.startsWith('refs/heads/') || ref.startsWith('refs/harmonic/');
}

/**
 * Parse `git for-each-ref --format='%(objectname) %(refname)'` output into a
 * {@link RefSnapshot}, keeping only the contract-relevant namespaces
 * ({@link isRelevantRef}). Blank lines are ignored, so an empty repo yields `{}`.
 */
export function parseRefLines(output: string): RefSnapshot {
  const snapshot: RefSnapshot = {};
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(' ');
    if (sep <= 0) continue;
    const oid = trimmed.slice(0, sep);
    const ref = trimmed.slice(sep + 1).trim();
    if (isRelevantRef(ref)) snapshot[ref] = oid;
  }
  return snapshot;
}

/**
 * The Run id a ref is attributed to by the `refs/harmonic/<purpose>/run-<id>`
 * naming convention, or `null` when the ref is not a Harmonic-owned ref (a
 * `refs/heads/*` branch, an external ref) — i.e. one Harmonic never moved and so
 * cannot claim. `<id>` must be a run of digits; a non-numeric tail yields `null`.
 */
export function ownedRefRunId(ref: string): number | null {
  const match = /^refs\/harmonic\/[^/]+\/run-(\d+)$/.exec(ref);
  return match ? Number(match[1]) : null;
}

/**
 * Diff two ref snapshots into the `RefDelta[]` the classifier consumes. A ref is
 * a delta when it was created (`from: null`), deleted (`to: null`), or moved
 * (`from !== to`) between `before` and `after`; unchanged refs are omitted. Each
 * delta is tagged via {@link ownedRefRunId} — so a moved Harmonic ref carries the
 * Run id embedded in its name (this Run's, or a foreign Run's), and any moved
 * `refs/heads/*` branch is unattributed (`null`). The classifier compares that
 * id against its own `runId` to decide owned-vs-foreign.
 */
export function diffRefs(before: RefSnapshot, after: RefSnapshot): RefDelta[] {
  const deltas: RefDelta[] = [];
  const refs = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const ref of [...refs].sort()) {
    const from = before[ref] ?? null;
    const to = after[ref] ?? null;
    if (from === to) continue;
    deltas.push({ ref, from, to, attributedRunId: ownedRefRunId(ref) });
  }
  return deltas;
}
