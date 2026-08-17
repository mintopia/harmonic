CREATE TABLE `landing_journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`effect` text,
	`idempotency_key` text,
	`payload` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `landing_journal_run_seq_unique` ON `landing_journal` (`run_id`,`seq`);