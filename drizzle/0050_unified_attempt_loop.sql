ALTER TABLE `workspaces` ADD `max_attempts` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD `feedback` text;--> statement-breakpoint
DROP INDEX `tasks_reattempt_of_idx`;--> statement-breakpoint
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `prompt` text NOT NULL,
  `harness` text,
  `model` text,
  `working_dir` text NOT NULL,
  `isolation_mode` text,
  `priority` text,
  `state` text NOT NULL,
  `workspace_id` integer REFERENCES `workspaces`(`id`),
  `feedback` text,
  `continuation_choice` text,
  `origin` text DEFAULT 'native' NOT NULL,
  `tracker_ref` integer,
  `workflow` text,
  `wayfinder_type` text,
  `drive` text,
  `escalated` integer DEFAULT false NOT NULL,
  `map_ref` integer,
  `base_branch` text,
  `tracker_state` text,
  `tracker_parent` integer,
  `tracker_blocked_by` text,
  `tracker_labels` text,
  `tracker_title` text,
  `tracker_body` text,
  `tracker_url` text,
  `tracker_created_at` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_tasks` (
  `id`, `prompt`, `harness`, `model`, `working_dir`, `isolation_mode`, `priority`, `state`, `workspace_id`,
  `feedback`, `continuation_choice`, `origin`, `tracker_ref`, `workflow`, `wayfinder_type`, `drive`, `escalated`,
  `map_ref`, `base_branch`, `tracker_state`, `tracker_parent`, `tracker_blocked_by`, `tracker_labels`, `tracker_title`,
  `tracker_body`, `tracker_url`, `tracker_created_at`, `created_at`, `updated_at`
) SELECT
  `id`, `prompt`, `harness`, `model`, `working_dir`, `isolation_mode`, `priority`, `state`, `workspace_id`,
  `feedback`, `continuation_choice`, `origin`, `tracker_ref`, `workflow`, `wayfinder_type`, `drive`, `escalated`,
  `map_ref`, `base_branch`, `tracker_state`, `tracker_parent`, `tracker_blocked_by`, `tracker_labels`, `tracker_title`,
  `tracker_body`, `tracker_url`, `tracker_created_at`, `created_at`, `updated_at`
FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_tracker_ref_idx` ON `tasks` (`workspace_id`,`tracker_ref`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_id_idx` ON `tasks` (`workspace_id`);
