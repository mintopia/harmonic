-- ADR-0001 (#388 S-G) / ADR-0007 "attempts is the single execution ledger":
-- fold the legacy `runs` ledger into `attempts`. `runs` carried the live
-- execution facts (branch/session/usage/cost/diff OIDs/…) the app still
-- reads; move them onto `attempts` (which already carries timeline identity
-- and every re-keyed satellite, ADR-0001 #388 S-F) so there is exactly one
-- execution ledger, then drop `runs`. `api_keys.run_id` (the ephemeral
-- run-scoped key mint) follows the same fold to `attempt_id`. Clean-break,
-- destructive, no shim (ADR-0007's clean-break policy: execution history is
-- disposable) — discarding `runs` rows is fine.

ALTER TABLE `attempts` ADD COLUMN `stop_reason` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `session_id` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `session_row_id` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `prompt` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `branch` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `base_branch` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `diff_base_oid` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `diff_head_oid` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `stat` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `candidate_oid` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `candidate_ref` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `usage` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `cost` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `live_usage` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `guardrail_config` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `price_table` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD COLUMN `detail` text;--> statement-breakpoint

ALTER TABLE `api_keys` RENAME COLUMN `run_id` TO `attempt_id`;--> statement-breakpoint

DROP TABLE `runs`;
