CREATE TABLE `verification_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`mechanism` text NOT NULL,
	`input_oid` text NOT NULL,
	`verdict` text NOT NULL,
	`summary` text NOT NULL,
	`output` text NOT NULL,
	`phase` text DEFAULT 'verifying' NOT NULL,
	`mutated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_attempts_run_seq_unique` ON `verification_attempts` (`run_id`,`seq`);