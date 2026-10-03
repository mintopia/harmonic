/** An opaque tracker ticket ref (`185`, `PROJ-185`): Harmonic never parses, orders, or formats it; the owning kind renders it. */
export type TrackerRef = string & { readonly __trackerRef: unique symbol };

/** Brands a string read from a tracker, a CLI argument, or a DB row as a {@link TrackerRef}. */
export function trackerRef(value: string | number): TrackerRef {
  return String(value) as TrackerRef;
}

/** The label that marks a wayfinder Map — convention on every tracker; `isMap` hides which. */
export const MAP_LABEL = 'wayfinder:map';

/** The label that marks a spec Epic — a container ticket, never mirrored as a work Task. */
export const EPIC_LABEL = 'epic';
