CREATE TABLE `run_tool_calls` (
	`run_id` integer NOT NULL,
	`tool_name` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`run_id`, `tool_name`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
