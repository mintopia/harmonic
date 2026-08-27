ALTER TABLE `tasks` ADD `integration_retries` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `conflict_resolve_turns` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `integration_retries` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `conflict_resolve_turns` integer;
