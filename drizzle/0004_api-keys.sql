CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scope` text DEFAULT 'full' NOT NULL,
	`run_id` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
