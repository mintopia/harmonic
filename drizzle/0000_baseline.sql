CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scope` text DEFAULT 'full' NOT NULL,
	`attempt_id` integer,
	`conversation_id` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `attempt_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `attempt_tool_calls` (
	`attempt_id` integer NOT NULL,
	`tool_name` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`attempt_id`, `tool_name`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`number` integer NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`feedback` text,
	`continuation` text,
	`reason` text,
	`stop_reason` text,
	`session_id` text,
	`session_row_id` integer,
	`prompt` text,
	`branch` text,
	`base_branch` text,
	`diff_base_oid` text,
	`diff_head_oid` text,
	`stat` text,
	`verified_head_oid` text,
	`verified_ref` text,
	`usage` text,
	`cost` text,
	`live_usage` text,
	`guardrail_config` text,
	`price_table` text,
	`detail` text,
	`pid` integer,
	`pgid` integer,
	`proc_start_token` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_row_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_number_unique` ON `attempts` (`task_id`,`number`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`events` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_events_conversation_id_idx` ON `conversation_events` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text,
	`harness` text NOT NULL,
	`model` text NOT NULL,
	`working_dir` text NOT NULL,
	`workspace_id` integer,
	`state` text NOT NULL,
	`session_id` text,
	`usage` text,
	`context_tokens` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `epics` (
	`workspace_id` integer NOT NULL,
	`tracker_ref` integer NOT NULL,
	`kind` text NOT NULL,
	`merge_commit` text,
	`state` text NOT NULL,
	`member_refs` text,
	PRIMARY KEY(`workspace_id`, `tracker_ref`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `epic_merge_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`epic_ref` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `epic_merge_events_epic_seq_unique` ON `epic_merge_events` (`workspace_id`,`epic_ref`,`seq`);--> statement-breakpoint
CREATE TABLE `guardrail_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`dimension` text NOT NULL,
	`limit_value` integer NOT NULL,
	`observed_value` integer NOT NULL,
	`config_source` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guardrail_events_attempt_seq_unique` ON `guardrail_events` (`attempt_id`,`seq`);--> statement-breakpoint
CREATE TABLE `permission_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`working_dir` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `permission_rules_kind_dir_idx` ON `permission_rules` (`kind`,`working_dir`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`job_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_id` integer,
	`last_run_at` integer,
	`last_status` text,
	`last_duration_ms` integer,
	`last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`harness` text NOT NULL,
	`harness_session_id` text NOT NULL,
	`model` text NOT NULL,
	`cwd` text NOT NULL,
	`workspace_id` integer,
	`transcript_path` text,
	`mcp_templates` text DEFAULT '[]' NOT NULL,
	`permission_mode` text,
	`capability_snapshot` text DEFAULT '{}' NOT NULL,
	`supports_load_session` integer DEFAULT false NOT NULL,
	`adapter_version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_active_at` integer NOT NULL,
	`worktree_path` text,
	`worktree_repo_dir` text,
	`retire_reason` text,
	`resume_incompatibility_reason` text,
	`resume_incompatibility_detail` text,
	`retire_deadline` integer,
	`retired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_harness_session_unique` ON `sessions` (`harness`,`harness_session_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`type` text NOT NULL,
	`position` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`command` text,
	`verdict` text,
	`log_locator` text,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_attempt_position_unique` ON `steps` (`attempt_id`,`position`);--> statement-breakpoint
CREATE TABLE `task_channels` (
	`task_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	PRIMARY KEY(`task_id`, `channel_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` integer NOT NULL,
	`depends_on_id` integer NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_id_idx` ON `task_dependencies` (`depends_on_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prompt` text NOT NULL,
	`harness` text,
	`model` text,
	`working_dir` text NOT NULL,
	`isolation_mode` text,
	`priority` text,
	`conflict_resolve_turns` integer,
	`state` text NOT NULL,
	`workspace_id` integer,
	`feedback` text,
	`continuation_choice` text,
	`origin` text DEFAULT 'native' NOT NULL,
	`tracker_ref` integer,
	`workflow` text,
	`wayfinder_type` text,
	`escalation_reason` text,
	`merge_status` text,
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
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_tracker_ref_idx` ON `tasks` (`workspace_id`,`tracker_ref`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_id_idx` ON `tasks` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `tracker_containers` (
	`workspace_id` integer NOT NULL,
	`tracker_ref` integer NOT NULL,
	`tracker_state` text NOT NULL,
	`tracker_parent` integer,
	`tracker_blocked_by` text NOT NULL,
	`tracker_labels` text NOT NULL,
	`tracker_title` text NOT NULL,
	`tracker_body` text NOT NULL,
	`tracker_url` text NOT NULL,
	`tracker_created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `tracker_ref`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tracker_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer,
	`tracker_ref` integer NOT NULL,
	`dismissed_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracker_dismissals_ws_ref_idx` ON `tracker_dismissals` (`workspace_id`,`tracker_ref`);--> statement-breakpoint
CREATE TABLE `verification_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`mechanism` text NOT NULL,
	`input_oid` text NOT NULL,
	`verdict` text NOT NULL,
	`summary` text NOT NULL,
	`output` text NOT NULL,
	`prompt` text,
	`transcript_path` text,
	`harness` text,
	`usage` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_attempts_attempt_seq_unique` ON `verification_attempts` (`attempt_id`,`seq`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`working_dir` text NOT NULL,
	`tracker_enabled` integer DEFAULT false NOT NULL,
	`tracker_poll_interval_seconds` integer DEFAULT 60 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_working_dir_idx` ON `workspaces` (`working_dir`);
