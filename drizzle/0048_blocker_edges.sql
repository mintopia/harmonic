-- Blocked is derived from task_dependencies at read and pick time. Existing
-- dependency rows are already the one-to-many blocker edge relation.
UPDATE `tasks` SET `state` = 'ready' WHERE `state` = 'blocked';
