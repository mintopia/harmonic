CREATE TABLE `guardrail_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`dimension` text NOT NULL,
	`phase` text NOT NULL,
	`limit_value` integer NOT NULL,
	`observed_value` integer NOT NULL,
	`config_source` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guardrail_events_run_seq_unique` ON `guardrail_events` (`run_id`,`seq`);