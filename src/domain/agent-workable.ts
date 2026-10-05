import type { WayfinderType } from '../db/schema.js';
import { DEFAULT_TRIAGE_LABELS, type TriageLabels } from '../tracker/triage-labels.js';

/**
 * The label half of the derived agent-workable flag for a mirrored ticket (the
 * other half is "no open Blockers"). Opt-in: the `readyForAgent` Triage Label
 * present, and not forced human-only — by the `readyForHuman` label, by a
 * wayfinder kind a human must drive, or by being a container. Assignment is
 * never consulted.
 */
export function mirroredAgentEligible(
  labels: readonly string[],
  wayfinderType: WayfinderType | null,
  isContainer: boolean,
  triage: Pick<TriageLabels, 'readyForAgent' | 'readyForHuman'> = DEFAULT_TRIAGE_LABELS,
): boolean {
  if (isContainer) return false;
  if (!labels.includes(triage.readyForAgent)) return false;
  if (labels.includes(triage.readyForHuman)) return false;
  return wayfinderType !== 'grilling' && wayfinderType !== 'prototype' && wayfinderType !== 'task';
}
