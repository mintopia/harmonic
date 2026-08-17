CREATE TABLE `turn_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`status` text NOT NULL,
	`purpose` text NOT NULL,
	`expected_phase` text,
	`expected_generation` integer,
	`expected_workspace_oid` text,
	`expected_fingerprint` text,
	`idempotency_key` text,
	`cancel_reason` text,
	`enqueued_at` integer NOT NULL,
	`claimed_at` integer,
	`sent_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_queue_session_seq_unique` ON `turn_queue` (`session_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `turn_queue_single_flight` ON `turn_queue` (`session_id`) WHERE "turn_queue"."status" = 'in_flight';