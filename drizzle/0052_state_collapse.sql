ALTER TABLE `tasks` ADD `escalation_reason` text;--> statement-breakpoint
UPDATE `tasks` SET `state` = 'working' WHERE `state` = 'running';--> statement-breakpoint
UPDATE `tasks` SET `state` = 'done' WHERE `state` = 'completed';--> statement-breakpoint
UPDATE `tasks` SET `state` = 'escalated', `escalation_reason` = 'awaiting human review when the review gate was removed (ADR-0041)' WHERE `state` = 'awaiting-review';--> statement-breakpoint
UPDATE `tasks` SET `state` = 'escalated', `escalation_reason` = COALESCE(
  (SELECT json_extract(f.`payload`, '$.reason') FROM `run_facts` f JOIN `runs` r ON r.`id` = f.`run_id` WHERE r.`task_id` = `tasks`.`id` AND f.`type` = 'escalate' ORDER BY f.`id` DESC LIMIT 1),
  'escalated before ADR-0041'
) WHERE `state` = 'ready' AND `escalated` = 1;--> statement-breakpoint
UPDATE `tasks` SET `state` = 'escalated', `escalation_reason` = COALESCE(
  (SELECT r.`reason` FROM `runs` r WHERE r.`task_id` = `tasks`.`id` ORDER BY r.`id` DESC LIMIT 1),
  'failed before ADR-0041'
) WHERE `state` = 'failed' AND EXISTS (SELECT 1 FROM `attempts` a WHERE a.`task_id` = `tasks`.`id`);--> statement-breakpoint
UPDATE `tasks` SET `state` = 'ready' WHERE `state` = 'failed';--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `drive`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `escalated`;--> statement-breakpoint
UPDATE `runs` SET `state` = 'completed', `phase` = 'terminal', `finished_at` = COALESCE(`finished_at`, `review_deadline`, `started_at`) WHERE `phase` = 'review';--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `review_deadline`;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `review`;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `review_feedback`;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `reviewed_at`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `verification_auto_accept`;--> statement-breakpoint
UPDATE `run_facts` SET `payload` = json_set(`payload`, '$.taskAction', 'done') WHERE json_extract(`payload`, '$.taskAction') IN ('completed', 'awaiting-review');--> statement-breakpoint
UPDATE `run_facts` SET `payload` = json_set(`payload`, '$.taskAction', 'ready') WHERE json_extract(`payload`, '$.taskAction') = 'failed';--> statement-breakpoint
UPDATE `sessions` SET `retire_reason` = 'retention-ttl' WHERE `retire_reason` IN ('reject-continuation-timeout', 'review-abandonment-sla');
