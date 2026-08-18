/**
 * The operator actions the Activity view's Work Context leases panel offers
 * for a given lease diagnostic (issue #125). Order is display order (left to
 * right). No lease state hides the action bar — unlike `taskActions`, both a
 * `held` and a `suspect` lease can be handed to a chosen Run (Supersede) or
 * force-released (Unlock); a suspect lease is simply the more urgent case for
 * offering the same two verbs.
 */
export type LeaseState = 'held' | 'suspect';
export type LeaseAction = 'supersede' | 'unlock';

export function leaseActions(state: LeaseState): LeaseAction[] {
  switch (state) {
    // Held: the lease is live under a running owner. An operator can still
    // hand it to another Run (Supersede) or force it open (Unlock) if the
    // owner is stuck.
    case 'held':
      return ['supersede', 'unlock'];
    // Suspect: the coordinator's heartbeat/TTL sweep flagged the owner as
    // possibly dead. The same two verbs apply — Supersede to hand it off,
    // Unlock to force-release — just with more urgency behind them.
    case 'suspect':
      return ['supersede', 'unlock'];
  }
  // A state from a server ahead of this bundle (version skew): offer nothing
  // rather than crash the panel on `.length` of undefined.
  return [];
}
