import type { PromptFragments } from '../domain/prompt-fragments.js';
import { codeIndexRepoGuidance, expandFragments, fillTemplate, renderFragment, type DriveFields } from './prompt-template.js';

const harnessLabel = (harness: string): string => harness.charAt(0).toUpperCase() + harness.slice(1);

const replaceTaskId = (text: string, taskId: number | string): string => text.replace(/\{taskId\}/g, String(taskId));

export function composeDriveOpening(
  drive: { prompt: string; unattendedReminder: string },
  fields: DriveFields,
  feedback?: string | null,
): string {
  const filled = fillTemplate(drive.prompt, fields);
  const trimmed = feedback?.trim();
  const withFeedback = trimmed ? `${filled}\n\n## Feedback from the previous attempt\n\n${trimmed}` : filled;
  return `${withFeedback}\n\n${replaceTaskId(drive.unattendedReminder, fields.taskId)}`;
}

export function composeContinuePrompt(drive: { continuePrompt: string; unattendedReminder: string }, taskId: number | string): string {
  return `${replaceTaskId(drive.continuePrompt, taskId)}\n\n${replaceTaskId(drive.unattendedReminder, taskId)}`;
}

export interface PeerEntry {
  taskId: number;
  harness: string;
  text: string;
}

/** Names the sending Task so the Agent never mistakes it for an operator instruction. */
export function peerFrame(sender: { id: number; harness: string }, text: string, fragments: PromptFragments): string {
  return renderFragment('peerLiveMessage', fragments, { taskId: sender.id, harness: harnessLabel(sender.harness), text });
}

/** Held messages as a prompt section, in send order. */
export function peerMessagesSection(held: readonly PeerEntry[], fragments: PromptFragments): string {
  const entries = held.map((entry) =>
    renderFragment('peerMessage', fragments, { taskId: entry.taskId, harness: harnessLabel(entry.harness), text: entry.text }),
  );
  return renderFragment('peerMessages', fragments, { messages: entries.join('\n\n') });
}

/** The held-messages section (when any are held) followed by the peer line. */
export function composePeerContext(held: readonly PeerEntry[], fragments: PromptFragments): string {
  const parts: string[] = [];
  if (held.length > 0) parts.push(peerMessagesSection(held, fragments));
  parts.push(renderFragment('peerLine', fragments));
  return parts.join('\n\n');
}

export interface AttemptPromptInput {
  /** `promptForTask(...)` or `composeDriveOpening(...)`. */
  opening: string;
  seed: string | undefined;
  /** `replace-all`: a steer into an already-open Attempt sends only the operator message. `append`: it follows the opening. */
  seedMode: 'replace-all' | 'append';
  /** Replaces the opening when an operator seed starts a fresh Session with prior context. */
  freshSessionContext: string | null;
  heal: { attempt: number; reason: string; output: string } | undefined;
  condensed: string | null;
  peerText: string;
  rebaseConflict: boolean;
  codeIndexRepoId: string | null;
}

export function composeAttemptPrompt(input: AttemptPromptInput, fragments: PromptFragments): string {
  const operatorSection = (seed: string) => renderFragment('operatorMessage', fragments, { seed });
  const { seed, heal } = input;
  let text = input.opening;
  let condensed: string | null = null;
  if (seed !== undefined && !heal) {
    if (input.seedMode === 'replace-all') text = operatorSection(seed);
    else text = `${input.freshSessionContext ?? text}\n\n${operatorSection(seed)}`;
  } else if (heal) {
    text = `${text}\n\n${renderFragment('selfHeal', fragments, { attempt: heal.attempt, reason: heal.reason, output: heal.output })}`;
    condensed = input.condensed;
    if (seed !== undefined) text = `${text}\n\n${operatorSection(seed)}`;
  } else {
    condensed = input.condensed;
  }
  if (input.peerText) text = `${text}\n\n${input.peerText}`;
  if (input.rebaseConflict) text = `${text}\n\n${renderFragment('rebaseConflict', fragments)}`;
  if (condensed) text = `${text}\n\n${condensed}`;
  if (input.codeIndexRepoId) text = `${text}${codeIndexRepoGuidance(input.codeIndexRepoId, fragments)}`;
  return text;
}

export interface ConflictPromptContext {
  turn: number;
  baseBranch: string;
  taskBranch: string;
  unmergedPaths: string[];
  baseDir: string;
}

/** Render a conflict-resolution turn prompt from its configured template, expanding Prompt Fragments and filling the merge placeholders. */
export function renderConflictPrompt(template: string, fragments: Record<string, string>, ctx: ConflictPromptContext): string {
  return fillTemplate(expandFragments(template, fragments), {
    turn: ctx.turn,
    taskBranch: ctx.taskBranch,
    baseBranch: ctx.baseBranch,
    baseDir: ctx.baseDir,
    paths: ctx.unmergedPaths.map((path) => `- ${path}`).join('\n'),
  });
}

export function renderEpicRefreshPrompt(
  template: string,
  fragments: Record<string, string>,
  ctx: { defaultBranch: string; branch: string; detail: string; worktreePath: string },
): string {
  return fillTemplate(expandFragments(template, fragments), {
    defaultBranch: ctx.defaultBranch,
    branch: ctx.branch,
    detail: ctx.detail,
    baseDir: ctx.worktreePath,
    baseBranch: ctx.branch,
    taskBranch: ctx.defaultBranch,
  });
}

export function composeEpicResolvePrompt(i: {
  resolvePrompt: string;
  resolveSuffix: string;
  fragments: PromptFragments;
  epic: { ref: string; title: string; body: string; url: string };
  reason: string;
  branch: string;
}): string {
  return [
    expandFragments(i.resolvePrompt, i.fragments)
      .replaceAll('{ref}', () => i.epic.ref)
      .replaceAll('{title}', () => i.epic.title)
      .replaceAll('{description}', () => i.epic.body)
      .replaceAll('{url}', () => i.epic.url),
    '',
    renderFragment('epicFailingVerification', i.fragments, { reason: i.reason }),
    '',
    fillTemplate(expandFragments(i.resolveSuffix, i.fragments), { branch: i.branch }),
  ].join('\n');
}
