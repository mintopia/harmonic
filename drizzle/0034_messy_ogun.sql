CREATE TABLE `execution_chains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `chain_id` integer REFERENCES execution_chains(id);