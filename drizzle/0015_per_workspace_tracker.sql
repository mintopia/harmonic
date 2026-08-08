DROP INDEX `tasks_tracker_ref_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_tracker_ref_idx` ON `tasks` (`workspace_id`,`tracker_ref`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `tracker_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `tracker_poll_interval_seconds` integer DEFAULT 60 NOT NULL;