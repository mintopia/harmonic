/** The merging side effects a caller may apply: a worktree merge, opening a PR, closing a tracker ticket. */
export const MERGE_EFFECTS = ['target-ref', 'open-pr', 'ticket-close'] as const;
export type MergeEffect = (typeof MERGE_EFFECTS)[number];

/** The outcome of applying one merging effect. `observed` is what the apply
 * step captured about the resulting world state (e.g. the merge commit OID);
 * `detail` is a human-readable failure/aux message. */
export type MergeEffectOutcome = { ok: boolean; observed?: Record<string, unknown> | undefined; detail?: string | undefined };

/** One merging side effect a caller must apply, in order. `apply` is expected
 * to resolve (not throw) with its outcome. */
export interface MergeEffectExec {
  effect: MergeEffect;
  idempotencyKey: string;
  expected: Record<string, unknown>;
  apply: () => Promise<MergeEffectOutcome>;
}
