-- ADR-0044 §C (issue #337): decompose the atomic critic override into four
-- independently-inheritable scalar columns. Add them, migrate each existing
-- `verification_critic` encoding once, then drop the old column. No read shim.
--   {"off":true}                     -> review_enabled = 0
--   review-shaped {"enabled":..,...} -> copy enabled/prompt/model/harness as-is
--   bare critic {prompt,model,...}   -> review_enabled = 1 + copy prompt/model/harness
--   null (inherit)                   -> all four stay null

ALTER TABLE `workspaces` ADD `review_enabled` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `review_prompt` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `review_model` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `review_harness` text;--> statement-breakpoint

-- Off sentinel {"off":true} -> explicitly disabled, no prompt/model/harness.
UPDATE `workspaces`
  SET `review_enabled` = 0
  WHERE `verification_critic` IS NOT NULL
    AND json_type(`verification_critic`) = 'object'
    AND json_extract(`verification_critic`, '$.off') = 1;--> statement-breakpoint

-- Review-shaped override (carries an `enabled` key) -> copy each field as-is.
UPDATE `workspaces`
  SET `review_enabled` = CASE WHEN json_extract(`verification_critic`, '$.enabled') = 1 THEN 1 ELSE 0 END,
      `review_prompt` = json_extract(`verification_critic`, '$.prompt'),
      `review_model` = json_extract(`verification_critic`, '$.model'),
      `review_harness` = json_extract(`verification_critic`, '$.harness')
  WHERE `verification_critic` IS NOT NULL
    AND json_type(`verification_critic`) = 'object'
    AND json_extract(`verification_critic`, '$.off') IS NULL
    AND json_type(`verification_critic`, '$.enabled') IS NOT NULL;--> statement-breakpoint

-- Bare critic {prompt,model,harness?} (no `enabled`, no `off`) -> enabled + copy.
UPDATE `workspaces`
  SET `review_enabled` = 1,
      `review_prompt` = json_extract(`verification_critic`, '$.prompt'),
      `review_model` = json_extract(`verification_critic`, '$.model'),
      `review_harness` = json_extract(`verification_critic`, '$.harness')
  WHERE `verification_critic` IS NOT NULL
    AND json_type(`verification_critic`) = 'object'
    AND json_extract(`verification_critic`, '$.off') IS NULL
    AND json_type(`verification_critic`, '$.enabled') IS NULL;--> statement-breakpoint

ALTER TABLE `workspaces` DROP COLUMN `verification_critic`;
