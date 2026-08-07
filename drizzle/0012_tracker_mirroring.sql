ALTER TABLE `tasks` ADD `origin` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracker_ref` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `workflow` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `wayfinder_type` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `drive` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `escalated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `map_ref` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_tracker_ref_idx` ON `tasks` (`tracker_ref`);