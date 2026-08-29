-- Ticket #388: rename the Attempt timeline row concept from "Attempt Task" to
-- "Step" — the word "Attempt" (the implement->verify loop iteration) stays;
-- only the per-row timeline unit renames, removing the overload with the
-- board's Task/Ticket. One-shot rename, data preserved, no shim.

-- Rename the table + its unique index (data preserved).
ALTER TABLE `attempt_tasks` RENAME TO `steps`;--> statement-breakpoint
DROP INDEX `attempt_tasks_attempt_position_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `steps_attempt_position_unique` ON `steps` (`attempt_id`,`position`);
