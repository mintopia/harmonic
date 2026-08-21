CREATE TABLE `run_event_firehose_pruning` (`id` integer PRIMARY KEY);
--> statement-breakpoint
DELETE FROM `run_events` WHERE `type` = 'session_update';
