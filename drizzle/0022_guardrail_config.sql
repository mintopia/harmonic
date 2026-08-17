ALTER TABLE `runs` ADD `guardrail_config` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `price_table` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `guardrail_budget` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `guardrail_progress` integer;