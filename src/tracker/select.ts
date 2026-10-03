import { normaliseKindId, trackerKindFor } from './kinds.js';
import type { ConfiguredTracker } from './configured.js';
import type { RepositoryKind } from '../repository/detect.js';

/** Which layer of the precedence chain supplied the Resolved Tracker. */
export type TrackerSource = 'configured' | 'detected' | 'code-repository';

export interface TrackerSelectionInput {
  configured?: ConfiguredTracker | null | undefined;
  /** The name from the repo's `docs/agents/issue-tracker.md` declaration, if any. */
  detectedName?: string | null | undefined;
  codeRepository?: RepositoryKind | null | undefined;
}

export interface TrackerSelection {
  kindId: string;
  source: TrackerSource;
}

/**
 * Tracker precedence: Configured Tracker, else Detected Tracker (a declaration naming a kind Harmonic
 * knows), else the Code Repository when it is also a tracker kind, else none.
 */
export function selectTracker(input: TrackerSelectionInput): TrackerSelection | null {
  if (input.configured) return { kindId: input.configured.kind, source: 'configured' };
  if (input.detectedName) {
    const kindId = normaliseKindId(input.detectedName);
    if (trackerKindFor(kindId)) return { kindId, source: 'detected' };
  }
  if (input.codeRepository && trackerKindFor(input.codeRepository)) return { kindId: input.codeRepository, source: 'code-repository' };
  return null;
}
