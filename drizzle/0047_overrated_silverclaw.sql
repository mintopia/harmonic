CREATE TABLE `scheduled_jobs` (
	`job_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_id` integer,
	`last_run_at` integer,
	`last_status` text,
	`last_duration_ms` integer,
	`last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
