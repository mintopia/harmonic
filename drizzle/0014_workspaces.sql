CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`working_dir` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_working_dir_idx` ON `workspaces` (`working_dir`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `workspace_id` integer REFERENCES workspaces(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `workspace_id` integer REFERENCES workspaces(id);--> statement-breakpoint
CREATE INDEX `tasks_workspace_id_idx` ON `tasks` (`workspace_id`);