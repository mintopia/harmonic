ALTER TABLE `tasks` ADD `reattempt_of` integer REFERENCES tasks(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `feedback` text;