-- ADR-0046: purge "land" vocabulary in favour of "merge" (task work into its
-- base) and "integrate" (the epic integration branch's role). One-shot data
-- migration that rewrites historical rows in place — no residue, no shim.

-- Rename the journal table + its unique index (data preserved).
ALTER TABLE `landing_journal` RENAME TO `merge_journal`;--> statement-breakpoint
DROP INDEX `landing_journal_run_seq_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `merge_journal_run_seq_unique` ON `merge_journal` (`run_id`,`seq`);--> statement-breakpoint

-- Session retire reason: 'landed' -> 'merged'.
UPDATE `sessions` SET `retire_reason` = 'merged' WHERE `retire_reason` = 'landed';--> statement-breakpoint

-- Run phase machine: 'landing' -> 'merging' across every persisted phase column.
UPDATE `runs` SET `phase` = 'merging' WHERE `phase` = 'landing';--> statement-breakpoint
UPDATE `verification_attempts` SET `phase` = 'merging' WHERE `phase` = 'landing';--> statement-breakpoint
UPDATE `turn_queue` SET `expected_phase` = 'merging' WHERE `expected_phase` = 'landing';--> statement-breakpoint
UPDATE `guardrail_events` SET `phase` = 'merging' WHERE `phase` = 'landing';--> statement-breakpoint

-- Lifecycle event payloads (run_events, type='lifecycle').
UPDATE `run_events` SET `payload` = json_set(`payload`, '$.event', 'merged')
  WHERE `type` = 'lifecycle' AND json_extract(`payload`, '$.event') = 'landed';--> statement-breakpoint
UPDATE `run_events` SET `payload` = json_set(`payload`, '$.event', 'rebase-required')
  WHERE `type` = 'lifecycle' AND json_extract(`payload`, '$.event') = 'freshness-rebase-required';--> statement-breakpoint
UPDATE `run_events` SET `payload` = json_set(`payload`, '$.event', 'merge-abandoned')
  WHERE `type` = 'lifecycle' AND json_extract(`payload`, '$.event') = 'landing-abandoned';--> statement-breakpoint
UPDATE `run_events` SET `payload` = json_set(`payload`, '$.phase', 'merging')
  WHERE `type` = 'lifecycle' AND json_extract(`payload`, '$.event') = 'phase' AND json_extract(`payload`, '$.phase') = 'landing';
