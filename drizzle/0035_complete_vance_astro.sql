CREATE TABLE `work_context_lease_dispositions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`action` text NOT NULL,
	`target_run_id` integer,
	`previous_owner_run_id` integer,
	`previous_state` text,
	`at` integer NOT NULL
);
