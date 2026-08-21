ALTER TABLE `tasks` ADD `tracker_state` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_parent` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_blocked_by` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_labels` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_title` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_body` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_url` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_created_at` text;