import { z } from 'zod';

export const taskRoutingSchema = z.object({ label: z.string(), applied: z.boolean() });
export type TaskRouting = z.infer<typeof taskRoutingSchema>;

/** Why an escalation happened, in a form the UI can branch on without parsing `escalationReason`. */
export const escalationCauseSchema = z.object({
  kind: z.literal('harness_unconfigured'),
  harness: z.string(),
  label: z.string().nullable(),
});
export type EscalationCause = z.infer<typeof escalationCauseSchema>;
