/** The Routing Label matching a mirrored Ticket; `applied` is false when an operator's Harness/Model override wins. */
export interface TaskRouting {
  label: string;
  applied: boolean;
}

/** Why an escalation happened, in a form the UI can branch on without parsing `escalationReason`. */
export type EscalationCause = { kind: 'harness_unconfigured'; harness: string; label: string | null };
