import type { AppConfig, RoutingLabelOverlayEntry } from '../types.js';
import { routingLabelIssueMessage, routingLabelOverlayIssues, routingLabelRef, type RoutingLabelIssue } from '../../../src/domain/setting-override.js';
import { withMissingGlobals } from './verification-override-model.js';

type RoutingLabel = AppConfig['routingLabels'][number];

/** An issue shows immediately unless it is the blank-label prompt, which waits until the row was touched. */
export const isIssueVisible = (issue: RoutingLabelIssue | undefined, touched: boolean): issue is RoutingLabelIssue =>
  issue !== undefined && (issue.kind !== 'blank' || touched);

export const issuesByIndex = (issues: readonly RoutingLabelIssue[]): Map<number, RoutingLabelIssue> =>
  new Map(issues.map((issue) => [issue.index, issue]));

export function firstIssueMessage(issues: readonly RoutingLabelIssue[], labelAt: (index: number) => string): string | null {
  const first = issues[0];
  return first ? `Routing Label ${first.index + 1}: ${routingLabelIssueMessage(first, labelAt(first.index))}` : null;
}

/** The overlay as displayed: any global not named is appended enabled, mirroring the runtime merge. */
export function overlayRows(overlay: readonly RoutingLabelOverlayEntry[] | null, globals: readonly RoutingLabel[]): RoutingLabelOverlayEntry[] {
  return withMissingGlobals<RoutingLabelOverlayEntry>(overlay, globals.map(routingLabelRef));
}

export function newLocalEntry(harness: string, model: string): RoutingLabelOverlayEntry {
  return { kind: 'local', enabled: true, routingLabel: { label: '', harness, model } };
}

export function firstRoutingOverlayError(
  overlay: readonly RoutingLabelOverlayEntry[] | null,
  globals: readonly RoutingLabel[],
): string | null {
  const rows = overlayRows(overlay, globals);
  return firstIssueMessage(routingLabelOverlayIssues(rows, globals), (index) => {
    const row = rows[index];
    return row?.kind === 'local' ? row.routingLabel.label : '';
  });
}
