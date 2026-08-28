-- Migrate persisted settings out of SQLite into the YAML settings file
-- (issue #391, ADR-0009): the global config already lived in the `settings`
-- KV table's `config` row (still there, just unused now — the table also
-- holds unrelated keys); these are the per-Workspace setting-override
-- columns, now owned by `SettingsStore`'s `settings.yaml`. Clean break: no
-- data migration, an operator's existing overrides are not carried forward.
ALTER TABLE `workspaces` DROP COLUMN `harness`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `chat_harness`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `chat_model`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `isolation_mode`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `priority`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `integration_retries`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `conflict_resolve_turns`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `max_concurrent_runs`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `auto_runner_enabled`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `verification_command`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `review_enabled`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `review_prompt`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `review_model`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `review_harness`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `guardrail_budget`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `guardrail_progress`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `max_attempts`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `context_reuse_token_limit`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `drive_prompt`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `drive_unattended_reminder`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `drive_continue_prompt`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `drive_merge_fate`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `drive_continue_attempts`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `task_prompt`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `tool_timeout_minutes`;
