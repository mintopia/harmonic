import type { AppConfig, RoutingLabelOverlayEntry } from '../types.js';
import { routingLabelOverlayIssues, routingLabelRef, type RoutingLabelIssue } from '../../../src/domain/setting-override.js';
import { withMissingGlobals } from './verification-override-model.js';

type RoutingLabel = AppConfig['routingLabels'][number];

export type RoutingIssueText = { before: string; globalRef?: string; after: string };

export function routingIssueText(issue: RoutingLabelIssue, label: string): RoutingIssueText {
  const text = label.trim();
  switch (issue.kind) {
    case 'blank':
      return { before: 'Enter a label.', after: '' };
    case 'duplicate':
      return { before: `“${text}” is already mapped above (labels match case-insensitively).`, after: '' };
    case 'duplicate-global':
      return {
        before: `“${text}” duplicates the enabled Global label `,
        globalRef: issue.globalRef,
        after: ' (labels match case-insensitively). Rename it, or disable the Global row above.',
      };
  }
}

export const routingIssueMessage = (issue: RoutingLabelIssue, label: string): string => {
  const { before, globalRef = '', after } = routingIssueText(issue, label);
  return before + globalRef + after;
};

/** An issue shows immediately unless it is the blank-label prompt, which waits until the row was touched. */
export const isIssueVisible = (issue: RoutingLabelIssue | undefined, touched: boolean): issue is RoutingLabelIssue =>
  issue !== undefined && (issue.kind !== 'blank' || touched);

export const issuesByIndex = (issues: readonly RoutingLabelIssue[]): Map<number, RoutingLabelIssue> =>
  new Map(issues.map((issue) => [issue.index, issue]));

export function firstIssueMessage(issues: readonly RoutingLabelIssue[], labelAt: (index: number) => string): string | null {
  const first = issues[0];
  return first ? `Routing Label ${first.index + 1}: ${routingIssueMessage(first, labelAt(first.index))}` : null;
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
