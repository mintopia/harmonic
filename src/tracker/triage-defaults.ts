import { z } from 'zod';

/** The label strings a Resolved Tracker uses for the roles Harmonic acts on. */
export const triageLabelsSchema = z.object({
  readyForAgent: z.string().min(1),
  readyForHuman: z.string().min(1),
  epic: z.string().min(1),
  wayfinderMap: z.string().min(1),
});
export type TriageLabels = z.infer<typeof triageLabelsSchema>;

/** A Workspace's explicit Triage Labels setting: any subset of the roles. */
export const triageLabelsOverrideSchema = triageLabelsSchema.partial().strict();
export type TriageLabelsOverride = z.infer<typeof triageLabelsOverrideSchema>;

export const DEFAULT_TRIAGE_LABELS: TriageLabels = {
  readyForAgent: 'ready-for-agent',
  readyForHuman: 'ready-for-human',
  epic: 'epic',
  wayfinderMap: 'wayfinder:map',
};
