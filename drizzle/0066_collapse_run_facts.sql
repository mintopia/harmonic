-- ADR-0001 (#388 S-E): collapse the run_facts append-only fact log + precedence
-- replay into the Attempt's own state. The single-process/single-writer model
-- (ADR-0007) has no coordination log to reconcile; an Attempt's disposition is
-- now `attempts.state` plus the ending-kind audit hedge on `attempts.reason`.
-- Clean-break, destructive, no shim (ADR-0007's clean-break policy).
ALTER TABLE `attempts` ADD COLUMN `reason` text;--> statement-breakpoint
DROP TABLE `run_facts`;
