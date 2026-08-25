CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL REFERENCES `tasks`(`id`),
	`number` integer NOT NULL,
	`state` text NOT NULL DEFAULT 'running',
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_number_unique` ON `attempts` (`task_id`,`number`);
--> statement-breakpoint
CREATE TABLE `attempt_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL REFERENCES `attempts`(`id`),
	`type` text NOT NULL,
	`position` integer NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`command` text,
	`verdict` text,
	`log_locator` text,
	`started_at` integer,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_tasks_attempt_position_unique` ON `attempt_tasks` (`attempt_id`,`position`);
--> statement-breakpoint
INSERT INTO `attempts` (`task_id`, `number`, `state`, `started_at`, `ended_at`)
SELECT `task_id`, `attempt`, CASE `state` WHEN 'completed' THEN 'passed' WHEN 'failed' THEN 'failed' ELSE 'running' END, `started_at`, `finished_at` FROM `runs`;
--> statement-breakpoint
INSERT INTO `attempt_tasks` (`attempt_id`, `type`, `position`, `state`, `verdict`, `log_locator`, `started_at`, `ended_at`)
SELECT `attempts`.`id`, 'implementation', 1,
  CASE `runs`.`state` WHEN 'completed' THEN 'passed' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'running' END,
  CASE `runs`.`state` WHEN 'completed' THEN 'pass' WHEN 'failed' THEN 'fail' ELSE NULL END,
  CASE WHEN `runs`.`session_row_id` IS NOT NULL THEN 'session:' || `runs`.`session_row_id` ELSE NULL END,
  `runs`.`started_at`, `runs`.`finished_at`
FROM `runs`
JOIN `attempts` ON `attempts`.`task_id` = `runs`.`task_id` AND `attempts`.`number` = `runs`.`attempt`;
--> statement-breakpoint
ALTER TABLE `run_facts` ADD `attempt_id` integer REFERENCES `attempts`(`id`);
--> statement-breakpoint
UPDATE `run_facts` SET `attempt_id` = (
  SELECT `attempts`.`id` FROM `attempts`
  JOIN `runs` ON `runs`.`task_id` = `attempts`.`task_id` AND `runs`.`attempt` = `attempts`.`number`
  WHERE `runs`.`id` = `run_facts`.`run_id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_facts_attempt_seq_unique` ON `run_facts` (`attempt_id`,`seq`);
