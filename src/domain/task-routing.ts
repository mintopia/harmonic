import { z } from 'zod';

export const taskRoutingSchema = z.object({ label: z.string(), applied: z.boolean() });
export type TaskRouting = z.infer<typeof taskRoutingSchema>;

/** What the Route Classifier did for a Ticket: `routed` chose a Model Option, `abstained` fell to the default, `overridden` was skipped because an operator setting won. */
export const taskClassifierSchema = z.object({
  kind: z.enum(['routed', 'abstained', 'overridden']),
  optionId: z.string().nullable(),
  reason: z.string().nullable(),
  /** The chosen option's 1-based place in the list the classifier saw, and that list's length; null unless routed. */
  position: z.number().int().nullable(),
  optionCount: z.number().int().nullable(),
});
export type TaskClassifier = z.infer<typeof taskClassifierSchema>;

/** The classifier's decision for one Attempt: it was consulted, so never `overridden`. */
export const attemptClassifierSchema = taskClassifierSchema.extend({ kind: z.enum(['routed', 'abstained']) });
export type AttemptClassifier = z.infer<typeof attemptClassifierSchema>;

export function classifierRouteOf(input: {
  enabled: boolean;
  labelMatched: boolean;
  operatorSet: boolean;
  latest:
    | { routeKind: 'classifier' | 'abstained' | null; routeOption: string | null; routeReason: string | null; routeOptionPosition: number | null; routeOptionCount: number | null }
    | undefined;
}): TaskClassifier | null {
  if (input.labelMatched) return null;
  if (input.operatorSet) return input.enabled ? { kind: 'overridden', optionId: null, reason: null, position: null, optionCount: null } : null;
  const { latest } = input;
  if (!latest?.routeKind) return null;
  return {
    kind: latest.routeKind === 'classifier' ? 'routed' : 'abstained',
    optionId: latest.routeOption,
    reason: latest.routeReason,
    position: latest.routeOptionPosition,
    optionCount: latest.routeOptionCount,
  };
}

/** Why an escalation happened, in a form the UI can branch on without parsing `escalationReason`. */
export const escalationCauseSchema = z.object({
  kind: z.literal('harness_unconfigured'),
  harness: z.string(),
  label: z.string().nullable(),
});
export type EscalationCause = z.infer<typeof escalationCauseSchema>;
