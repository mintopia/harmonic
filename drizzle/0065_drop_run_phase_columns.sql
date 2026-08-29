-- ADR-0001 (#388 S-D): drop the Run phase machine. Run/Phase are deleted
-- concepts (ADR-0001 Vocabulary) — the Attempt's timeline is Steps
-- (Implementation, Verification, Review), already the live source of truth
-- via the `steps` table. `phase` on all three tables is unread by any
-- surviving code path; clean-break, destructive, no shim.
ALTER TABLE `runs` DROP COLUMN `phase`;--> statement-breakpoint
ALTER TABLE `verification_attempts` DROP COLUMN `phase`;--> statement-breakpoint
ALTER TABLE `guardrail_events` DROP COLUMN `phase`;
