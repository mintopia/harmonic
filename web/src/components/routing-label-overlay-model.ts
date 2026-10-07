import type { AppConfig, RoutingLabelOverlayEntry } from '../types.js';
import { withMissingGlobals } from './verification-override-model.js';

type RoutingLabel = AppConfig['routingLabels'][number];

export type RoutingOverlayError = { message: string; globalRef?: string };

export const routingLabelKey = (label: string): string => label.trim().toLowerCase();

/** The overlay as displayed: any global not named is appended enabled, mirroring the runtime merge. */
export function overlayRows(overlay: readonly RoutingLabelOverlayEntry[] | null, globals: readonly RoutingLabel[]): RoutingLabelOverlayEntry[] {
  return withMissingGlobals<RoutingLabelOverlayEntry>(overlay, globals.map((g) => routingLabelKey(g.label)));
}

export function newLocalEntry(harness: string, model: string): RoutingLabelOverlayEntry {
  return { kind: 'local', enabled: true, routingLabel: { label: '', harness, model } };
}

/**
 * Per-row errors for the displayed rows. An enabled local label may not repeat
 * an enabled global label (a disabled global frees its label) or an earlier
 * enabled local one; disabled locals are not checked.
 */
export function routingOverlayErrors(
  rows: readonly RoutingLabelOverlayEntry[],
  globals: readonly RoutingLabel[],
): (RoutingOverlayError | null)[] {
  const disabled = new Set(rows.flatMap((r) => (r.kind === 'global' && !r.enabled ? [r.ref] : [])));
  const globalKeys = new Set(globals.map((g) => routingLabelKey(g.label)).filter((key) => !disabled.has(key)));
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.kind !== 'local' || !row.enabled) return null;
    const label = row.routingLabel.label.trim();
    const key = routingLabelKey(label);
    if (key === '') return { message: 'Enter a label.' };
    if (globalKeys.has(key)) {
      return {
        message: `“${label}” duplicates the enabled Global label \`${key}\` (labels match case-insensitively). Rename it, or disable the Global row above.`,
        globalRef: key,
      };
    }
    if (seen.has(key)) return { message: `“${label}” is already mapped above (labels match case-insensitively).` };
    seen.add(key);
    return null;
  });
}

export function firstRoutingOverlayError(
  overlay: readonly RoutingLabelOverlayEntry[] | null,
  globals: readonly RoutingLabel[],
): string | null {
  const errors = routingOverlayErrors(overlayRows(overlay, globals), globals);
  const index = errors.findIndex((e) => e !== null);
  return index === -1 ? null : `Routing Label ${index + 1}: ${errors[index]!.message}`;
}
