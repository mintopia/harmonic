import type { WorkspaceRow } from '../db/schema.js';
import { routingLabelOverrideSchema, type AppConfig, type RoutingLabel, type RoutingLabelOverlayEntry } from '../config.js';
import { isOverridable } from './settings-registry.js';
import { mergeLabelOverlay } from './setting-override.js';

export function parseRoutingLabelOverlay(stored: string | null | undefined): RoutingLabelOverlayEntry[] | null {
  return stored == null ? null : routingLabelOverrideSchema.parse(JSON.parse(stored));
}

/** Effective Routing Labels: null inherits all globals; a local shadowed by an enabled global is dropped. */
export function resolveRoutingLabels(
  ws: Pick<WorkspaceRow, 'routingLabels'> | null | undefined,
  config: Pick<AppConfig, 'routingLabels'>,
): RoutingLabel[] {
  const overlay = parseRoutingLabelOverlay(isOverridable('routingLabels') ? ws?.routingLabels : null);
  return mergeLabelOverlay<RoutingLabel, RoutingLabelOverlayEntry>(overlay, config.routingLabels, (e) => e.ref, (e) => e.routingLabel);
}
