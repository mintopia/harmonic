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
