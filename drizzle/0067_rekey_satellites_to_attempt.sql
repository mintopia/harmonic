-- ADR-0001 (#388 S-F) / ADR-0007 "The DB stores aggregates, not event
-- streams": Attempt is becoming the single execution ledger. Re-key every
-- surviving per-execution satellite table off `attempts.id` instead of the
-- legacy `runs.id` — two renamed (`run_tool_calls` -> `attempt_tool_calls`,
-- `run_events` -> `attempt_events`), two re-keyed in place
-- (`verification_attempts`, `guardrail_events`). Clean-break, destructive,
-- no shim (ADR-0007's clean-break policy: execution history is disposable) —
-- drop and recreate rather than backfill run_id -> attempt_id data.

DROP TABLE `verification_attempts`;--> statement-breakpoint
CREATE TABLE `verification_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`mechanism` text NOT NULL,
	`input_oid` text NOT NULL,
	`verdict` text NOT NULL,
	`summary` text NOT NULL,
	`output` text NOT NULL,
	`transcript_path` text,
	`harness` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_attempts_attempt_seq_unique` ON `verification_attempts` (`attempt_id`,`seq`);--> statement-breakpoint

DROP TABLE `guardrail_events`;--> statement-breakpoint
CREATE TABLE `guardrail_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`dimension` text NOT NULL,
	`limit_value` integer NOT NULL,
	`observed_value` integer NOT NULL,
	`config_source` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guardrail_events_attempt_seq_unique` ON `guardrail_events` (`attempt_id`,`seq`);--> statement-breakpoint

DROP TABLE `run_tool_calls`;--> statement-breakpoint
CREATE TABLE `attempt_tool_calls` (
	`attempt_id` integer NOT NULL,
	`tool_name` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`attempt_id`, `tool_name`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

DROP TABLE `run_events`;--> statement-breakpoint
CREATE TABLE `attempt_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
