-- ADR-0044 §D (issue #338): the per-Workspace command-verifier override becomes
-- list-grain — null = inherit the global list, [] = off (run no commands here),
-- [command, ...] = override the whole list. Migrate the old tri-state encodings
-- in place, no read-time shim: the {"off":true} sentinel becomes an explicit
-- empty array, and a single stored command object becomes a one-element array.
-- Existing arrays and nulls (inherit) already carry the new meaning, untouched.
-- Only the command column changes; the critic keeps its {"off":true} sentinel.

-- {"off":true} sentinel -> [] (explicit "run no commands in this Workspace").
UPDATE `workspaces`
  SET `verification_command` = '[]'
  WHERE `verification_command` IS NOT NULL
    AND json_type(`verification_command`) = 'object'
    AND json_extract(`verification_command`, '$.off') = 1;--> statement-breakpoint

-- Single command object -> [ command ] (a one-element ordered list). Runs after
-- the sentinel rewrite above, so those rows are already arrays and skipped here.
UPDATE `workspaces`
  SET `verification_command` = json_array(json(`verification_command`))
  WHERE `verification_command` IS NOT NULL
    AND json_type(`verification_command`) = 'object';
