-- Drop the verifier mutation-detection column. The fingerprint that populated
-- it (worktree tree + base-repo refs, `execution/detached-worktree.ts`) treated
-- a base branch advancing during a critic run as the critic "mutating" its
-- checkout and force-overrode a `pass` to `inconclusive`. Base branches are
-- expected to move; the whole check is removed, column and all.
ALTER TABLE `verification_attempts` DROP COLUMN `mutated`;
