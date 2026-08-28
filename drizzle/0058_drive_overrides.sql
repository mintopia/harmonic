ALTER TABLE `workspaces` ADD `drive_prompt` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `drive_unattended_reminder` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `drive_continue_prompt` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `drive_merge_fate` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `drive_continue_attempts` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `task_prompt` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `tool_timeout_minutes` integer;
