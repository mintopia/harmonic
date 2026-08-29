/**
 * The merging effect vocabulary (ADR-0001, ADR-0007): the set of irreversible
 * side effects a Run's completion can trigger once accepted — merging a
 * worktree branch into its base, opening a PR, closing a tracker ticket — and
 * the shape one such effect takes when a caller (the runner's completion
 * path, `EscalationService.accept`) applies it directly.
 *
 * No database, no clock, no I/O: a pure vocabulary module, kept free-standing
 * so `db/schema.ts` can brand a column with {@link MergeEffect} without a
 * runtime db→domain import cycle. The one merge policy itself
 * (`execution/merge-policy.ts`) runs under the base repo mutex and settles
 * through `RunSettleCoordinator` directly — there is no journal, PONC, or
 * reconciliation layer here (that machinery, and the `merge_journal` table it
 * read/wrote, is gone: ADR-0001 "no merge journal", ADR-0007's target schema).
 */

/**
 * The merging side effects a caller may apply. Only `target-ref` (a worktree
 * merge) has a live executor today; `open-pr` and `ticket-close` are modelled
 * here so later units slot in without touching this module's contract — same
 * "open for extension" shape as `GUARDRAIL_DIMENSIONS` (db/schema.ts).
 */
export const MERGE_EFFECTS = ['target-ref', 'open-pr', 'ticket-close'] as const;
export type MergeEffect = (typeof MERGE_EFFECTS)[number];

/** The outcome of applying one merging effect. `observed` is whatever the
 * effect's own apply step captured about the resulting world state (e.g. the
 * merge commit OID); `detail` is a human-readable failure/aux message.
 * `| undefined` (not just `?:`) on the optional fields so a caller can forward
 * an outcome verbatim under this repo's `exactOptionalPropertyTypes`. */
export type MergeEffectOutcome = { ok: boolean; observed?: Record<string, unknown> | undefined; detail?: string | undefined };

/** One merging side effect a caller must apply, in order. `apply` is expected
 * to resolve (not throw) with its outcome. */
export interface MergeEffectExec {
  effect: MergeEffect;
  idempotencyKey: string;
  expected: Record<string, unknown>;
  apply: () => Promise<MergeEffectOutcome>;
}
