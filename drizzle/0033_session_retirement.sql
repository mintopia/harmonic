ALTER TABLE `sessions` ADD `worktree_path` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `worktree_repo_dir` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `retire_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `retire_deadline` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `retired_at` integer;