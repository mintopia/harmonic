CREATE TABLE `tracker_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer,
	`tracker_ref` integer NOT NULL,
	`dismissed_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracker_dismissals_ws_ref_idx` ON `tracker_dismissals` (`workspace_id`,`tracker_ref`);