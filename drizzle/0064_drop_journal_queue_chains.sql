-- ADR-0001 / ADR-0007: drop the coordination tables the target schema
-- explicitly excludes — no leases, no turn queue, no merge journal, no
-- execution chains. All three are dead: their only consumers (the journaled
-- MergeCoordinator merge path, the self-heal turn-queue producer, and the
-- cross-Run cumulative spend guard) were removed in this same change
-- (ADR-0001 #388 S-C). Clean-break, destructive, no shim.
ALTER TABLE `runs` DROP COLUMN `chain_id`;--> statement-breakpoint
DROP TABLE `merge_journal`;--> statement-breakpoint
DROP TABLE `turn_queue`;--> statement-breakpoint
DROP TABLE `execution_chains`;
