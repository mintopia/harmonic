import type { WayfinderType } from '../db/schema.js';

/**
 * The one triage label that opts a mirrored ticket into autonomous work (issue
 * #230): present ⇒ agent-eligible, absent ⇒ human-only (never auto-picked).
 * Read through this shared constant by every eligibility gate so the polarity
 * holds on every tracker, no per-call literal.
 */
export const READY_FOR_AGENT_LABEL = 'ready-for-agent';

/** The triage label that keeps a ticket human-only whatever else it carries (issue #230). */
export const READY_FOR_HUMAN_LABEL = 'ready-for-human';

/**
 * The label half of ADR-0041's derived agent-workable flag for a mirrored
 * ticket (the other half is "no open Blockers", derived from edges). Opt-in:
 * `ready-for-agent` present, and not forced human-only — by `ready-for-human`,
 * by a wayfinder kind a human must drive (grilling / prototype / task), or by
 * being an Epic container (a ticket with children is never worked itself).
 * Assignment is never consulted (issue #208). Pure, so the Auto-Runner pick,
 * the Epic ready-frontier, and the board all agree.
 */
export function mirroredAgentEligible(
  labels: readonly string[],
  wayfinderType: WayfinderType | null,
  isEpicContainer: boolean,
): boolean {
  if (isEpicContainer) return false;
  if (!labels.includes(READY_FOR_AGENT_LABEL)) return false;
  if (labels.includes(READY_FOR_HUMAN_LABEL)) return false;
  return wayfinderType !== 'grilling' && wayfinderType !== 'prototype' && wayfinderType !== 'task';
}
