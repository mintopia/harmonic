import type { WayfinderType } from '../db/schema.js';

/** The triage label that opts a mirrored ticket into autonomous work: present ⇒ agent-eligible, absent ⇒ human-only. */
export const READY_FOR_AGENT_LABEL = 'ready-for-agent';

/** The triage label that keeps a ticket human-only whatever else it carries. */
export const READY_FOR_HUMAN_LABEL = 'ready-for-human';

/**
 * The label half of the derived agent-workable flag for a mirrored ticket (the
 * other half is "no open Blockers"). Opt-in: `ready-for-agent` present, and
 * not forced human-only — by `ready-for-human`, by a wayfinder kind a human
 * must drive, or by being a container. Assignment is never consulted.
 */
export function mirroredAgentEligible(
  labels: readonly string[],
  wayfinderType: WayfinderType | null,
  isContainer: boolean,
): boolean {
  if (isContainer) return false;
  if (!labels.includes(READY_FOR_AGENT_LABEL)) return false;
  if (labels.includes(READY_FOR_HUMAN_LABEL)) return false;
  return wayfinderType !== 'grilling' && wayfinderType !== 'prototype' && wayfinderType !== 'task';
}
