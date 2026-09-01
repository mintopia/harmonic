# Decision: Epics are first-class stored resources

Status: accepted
Date: 2026-09-01

## Context

ADR-0016 made an Epic a **container** — label-driven, non-runnable, and
explicitly *"not a stored entity — a query-time roll-up over the polled
tracker"* (`deriveEpics` / `listEpics` over `tracker_containers`). That was the
right call for grouping open work, and it stands. But the derived model cannot
carry state that git and the live tracker no longer hold:

- **The whole-Epic diff.** We want to show what an Epic changed, base vs. epic
  branch. While open that is derivable (`git diff <base>...epic/<ref>`). Once
  integrated it is not: retirement **deletes** `epic/<ref>` (branch-retirement
  `retireContained` → `deleteBranch`), and `refreshDriftedEpics` merges the base
  forward into the epic branch repeatedly, so no fork point survives to diff
  from. The only durable, policy-independent anchor is the **integration merge
  commit**, whose two parents are exactly base-before and epic-tip — but nothing
  records which commit that is.
- **Historical Epics.** A closed Epic's container row is pruned when the scan
  stops returning it, and its members can be Dismissed. A derived-only model
  loses the Epic and its membership the moment it closes.
- **The Epic's kind at drive time.** A Map's children must be driven
  `/wayfinder {mapRef}` rather than `/implement {childRef}`; that decision needs
  a stable `kind`, not a re-walk of labels/structure that a historical Epic no
  longer has.

Deriving these from merge-commit archaeology (grep the log for
`Merge branch 'epic/<ref>'`, diff its parents) is fragile: it depends on the
merge-commit message format and the one-merge policy holding forever.

## Decision

The **leaf-most** Epic (the integration unit) becomes a **first-class stored
resource** — a thin durable spine beside the live derived model, not a
replacement for it.

- **New `epics` table**, keyed `(workspace, ref)`, coexisting with
  `tracker_containers`. The container row stays the wipe-and-replace live cache
  (`syncTrackerContainers`); the Epic record is durable state the scan wipe never
  touches. Stored columns: `kind` (`map` | `spec` | `epic`), the integration
  **merge-commit hash** (nullable), lifecycle state, and a **member-ref
  snapshot** (int array, taken at integration). No `startHash` — the merge
  commit's parents give both diff endpoints.
- **Lazy create, persist forever.** A row is created the first scan a leaf-most
  Epic is seen with ≥1 member. It is updated in place while live and **survives
  the tracker issue closing**; it is removed only on explicit **Dismiss**. A
  leaf-most Epic that later becomes a spine keeps its row with its hashes frozen.
- **`kind` is a refreshed cache, not authored.** Re-derived every scan from live
  facts (Map = `wayfinder:map` label; Spec = spec body + children; plain Epic =
  children only), so it tracks reality while live and freezes when the issue
  closes.
- **Every Epic cuts `epic/<ref>`** (uniform across kinds — a Map can produce
  ADRs / CONTEXT.md changes like any Epic). Finishing merges the branch to base;
  when branch and base already match it is a **no-op** and the merge-commit hash
  stays null. The whole-Epic diff is `base head vs epic-branch head` while open
  and `git diff <M>^1 <M>^2` from the stored merge commit `M` once integrated.
- **Epic completion closes the tracker issue.** When a leaf-most Epic is done
  (integrated, or a no-op finish), Harmonic closes its tracker issue via the
  writable adapter — the container itself never runs an agent, so nothing else
  would close it.
- **Membership and structure stay derived.** Parent/spine Epics remain derived
  roll-ups; live members come from `mapRef`/parentage. Only the snapshot (for
  historical fidelity) and the spine columns above are stored.

## Consequences

- The whole-Epic diff resolves for open **and** historical Epics without
  grepping the log or depending on the merge-commit message format.
- Reverses ADR-0016's "not a stored entity" for the leaf-most Epic only; the
  container model, label-driven identification, non-runnable/non-blocking
  semantics, and the derived roll-up for spine Epics all stand.
- Reverses the direction of ADR-0004's closure rule **for Epics**: issue closure
  is normally mirrored *in* as an output side-effect, but an Epic's own tracker
  issue is now closed *out* by Harmonic on completion.
- Extends the ADR-0017 Epic surface with a diff panel fed by the stored record.
- Adds a third `kind`, the **plain Epic** (bare parent/child, neither Map nor
  Spec); only `map` changes child-drive behaviour.
- `/wayfinder {mapRef}` child drive is net-new: `skillFor` currently emits only
  `/research` or `/implement`, always against the child's own ref.

## Supersedes

None wholesale. Reverses the storage claim of
0016-epics-are-containers.md (leaf-most Epics are now stored; the container and
derived-roll-up model otherwise stands), reverses the closure direction of
0004-tracker-mirroring-and-ticket-sourcing.md for Epics, and extends
0017-epic-summary-page-replaces-board-focus.md with the whole-Epic diff.
