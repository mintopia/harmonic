CREATE TABLE `work_context_leases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`phase` text NOT NULL,
	`owner_run_id` integer NOT NULL,
	`heartbeat` integer NOT NULL,
	`expiry` integer,
	`state` text NOT NULL,
	`acquired_at` integer NOT NULL,
	FOREIGN KEY (`owner_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_context_leases_key_unique` ON `work_context_leases` (`key`);