CREATE TABLE `permission_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`working_dir` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `permission_rules_kind_dir_idx` ON `permission_rules` (`kind`,`working_dir`);