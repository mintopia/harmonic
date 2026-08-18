CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`harness` text NOT NULL,
	`harness_session_id` text NOT NULL,
	`model` text NOT NULL,
	`cwd` text NOT NULL,
	`workspace_id` integer,
	`mcp_templates` text DEFAULT '[]' NOT NULL,
	`permission_mode` text,
	`capability_snapshot` text DEFAULT '{}' NOT NULL,
	`supports_load_session` integer DEFAULT false NOT NULL,
	`adapter_version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_active_at` integer NOT NULL,
	`estimated_warm_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_harness_session_unique` ON `sessions` (`harness`,`harness_session_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `session_row_id` integer REFERENCES sessions(id);