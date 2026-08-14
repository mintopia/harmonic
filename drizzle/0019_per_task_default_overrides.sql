PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prompt` text NOT NULL,
	`harness` text,
	`model` text,
	`working_dir` text NOT NULL,
	`isolation_mode` text,
	`priority` text,
	`state` text NOT NULL,
	`workspace_id` integer,
	`reattempt_of` integer,
	`feedback` text,
	`origin` text DEFAULT 'native' NOT NULL,
	`tracker_ref` integer,
	`workflow` text,
	`wayfinder_type` text,
	`drive` text,
	`escalated` integer DEFAULT false NOT NULL,
	`map_ref` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reattempt_of`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "prompt", "harness", "model", "working_dir", "isolation_mode", "priority", "state", "workspace_id", "reattempt_of", "feedback", "origin", "tracker_ref", "workflow", "wayfinder_type", "drive", "escalated", "map_ref", "created_at", "updated_at") SELECT "id", "prompt", "harness", "model", "working_dir", "isolation_mode", "priority", "state", "workspace_id", "reattempt_of", "feedback", "origin", "tracker_ref", "workflow", "wayfinder_type", "drive", "escalated", "map_ref", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_reattempt_of_idx` ON `tasks` (`reattempt_of`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_tracker_ref_idx` ON `tasks` (`workspace_id`,`tracker_ref`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_id_idx` ON `tasks` (`workspace_id`);--> statement-breakpoint
-- ADR-0012: a mirrored (imported) Task never had its defaults set by an
-- operator — it took a snapshot at mirror time. Clear those to `null` so every
-- imported ticket now *inherits* its Workspace/global defaults and follows a
-- later default change. Native (authored) Tasks keep whatever the form pinned.
UPDATE `tasks` SET `harness` = NULL, `model` = NULL, `isolation_mode` = NULL, `priority` = NULL WHERE `origin` = 'mirrored';