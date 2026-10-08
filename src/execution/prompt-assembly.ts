import type { PromptFragments } from '../domain/prompt-fragments.js';
import { appendFeedback, codeIndexRepoGuidance, expandFragments, fillTemplate, renderFragment, type DriveFields } from './prompt-template.js';

const harnessLabel = (harness: string): string => harness.charAt(0).toUpperCase() + harness.slice(1);

const replaceTaskId = (text: string, taskId: number | string): string => text.replace(/\{taskId\}/g, String(taskId));

export function composeDriveOpening(
  drive: { prompt: string; unattendedReminder: string },
  fields: DriveFields,
  feedback?: string | null,
): string {
  return `${appendFeedback(fillTemplate(drive.prompt, fields), feedback)}\n\n${replaceTaskId(drive.unattendedReminder, fields.taskId)}`;
}

export function composeContinuePrompt(drive: { continuePrompt: string; unattendedReminder: string }, taskId: number | string): string {
  return `${replaceTaskId(drive.continuePrompt, taskId)}\n\n${replaceTaskId(drive.unattendedReminder, taskId)}`;
}

export const composeCommitNudge = (template: string, fragments: PromptFragments): string => expandFragments(template, fragments);

export const composePauseMessage = (template: string, fragments: PromptFragments): string => expandFragments(template, fragments);

export interface PeerEntry {
  taskId: number;
  harness: string;
  text: string;
}

/** Names the sending Task so the Agent never mistakes it for an operator instruction. */
export function peerFrame(sender: { id: number; harness: string }, text: string, fragments: PromptFragments): string {
  return renderFragment('peerLiveMessage', fragments, { taskId: sender.id, harness: harnessLabel(sender.harness), text });
}

function peerMessagesSection(held: readonly PeerEntry[], fragments: PromptFragments): string {
  const entries = held.map((entry) =>
    renderFragment('peerMessage', fragments, { taskId: entry.taskId, harness: harnessLabel(entry.harness), text: entry.text }),
  );
  return renderFragment('peerMessages', fragments, { messages: entries.join('\n\n') });
}

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

export interface AttemptContextFacts {
  seeded: boolean;
  healing: boolean;
  /** The Attempt already has an open Session that this turn continues. */
  continuesOpenAttempt: boolean;
  /** No Session is open yet, so a seeded turn starts a fresh one. */
  freshSession: boolean;
  /** The Task chose to continue from a condensed prior Session. */
  condensedContinuation: boolean;
}

export type PriorContextSlot = 'freshSessionContext' | 'condensed';

/** Decides the seed mode and which {@link AttemptPromptInput} field the prior-session context fills, if any. */
export function planAttemptContext(facts: AttemptContextFacts): { seedMode: AttemptPromptInput['seedMode']; priorSlot: PriorContextSlot | null } {
  const seedMode = facts.continuesOpenAttempt ? 'replace-all' : 'append';
  if (facts.seeded && !facts.healing) return { seedMode, priorSlot: facts.freshSession ? 'freshSessionContext' : null };
  if (facts.healing || facts.condensedContinuation) return { seedMode, priorSlot: 'condensed' };
  return { seedMode, priorSlot: null };
}

export function placePriorContext(
  slot: PriorContextSlot | null,
  prior: string | null,
): Pick<AttemptPromptInput, 'freshSessionContext' | 'condensed'> {
  const text = prior || null;
  return { freshSessionContext: slot === 'freshSessionContext' ? text : null, condensed: slot === 'condensed' ? text : null };
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

const expandAndFill = (template: string, fragments: Record<string, string>, fields: Record<string, string | number>): string =>
  fillTemplate(expandFragments(template, fragments), fields);

/** Render a conflict-resolution turn prompt from its configured template, expanding Prompt Fragments and filling the merge placeholders. */
export function renderConflictPrompt(template: string, fragments: Record<string, string>, ctx: ConflictPromptContext): string {
  return expandAndFill(template, fragments, {
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
  return expandAndFill(template, fragments, {
    defaultBranch: ctx.defaultBranch,
    branch: ctx.branch,
    detail: ctx.detail,
    baseDir: ctx.worktreePath,
    // The shared Conflict resolution fragment speaks of a merge into baseBranch; a refresh merges the default branch into the Epic branch.
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

export interface BuildCriticPromptArgs {
  /** The operator's configured critic prompt; supports the Drive Prompt's
   * `{taskId}/{skill}/{ref}/{url}/{title}/{description}` interpolation. */
  operatorPrompt: string;
  /** The Drive-Prompt interpolation tokens. */
  fields: DriveFields;
  /** The candidate revision the worktree is checked out at. */
  verifiedHeadOid: string;
  /** The base revision the candidate diverged from; absent ⇒ the critic reviews the candidate alone. */
  baseOid?: string;
  /** True when the worktree still carries uncommitted work on top of {@link verifiedHeadOid}, pending a
   * pre-merge commit — the true candidate is the working tree, not the `verifiedHeadOid` commit alone. */
  dirty?: boolean;
  fragments: PromptFragments;
}

/** Build the critic's review prompt: operator prompt, revision block, restraint instruction, output contract. Pure, so the settings preview renders the same compiled prompt. */
export function buildCriticPrompt({
  operatorPrompt,
  fields,
  verifiedHeadOid,
  baseOid,
  dirty,
  fragments,
}: BuildCriticPromptArgs): string {
  const hasTicket = fields.ref.trim() !== '' || fields.url.trim() !== '';
  const interpolated = fillTemplate(expandFragments(operatorPrompt, fragments), fields);
  // A native (board-authored) Task has no mirrored issue: `ref`/`url` are empty,
  // so the critic must judge against the instructions themselves, not a ticket
  // that does not exist. `taskId`/`title`/`description` still resolve — they come
  // from the Task itself, not the ticket.
  const spec = renderFragment(hasTicket ? 'criticSpecTicket' : 'criticSpecInstructions', fragments);
  const ticketFirst = renderFragment(hasTicket ? 'criticTicketFirst' : 'criticInstructionsFirst', fragments);
  const workingTreeNote = dirty
    ? ` ${renderFragment('criticWorkingTreeNote', fragments, { head: verifiedHeadOid, base: baseOid ?? verifiedHeadOid })}`
    : '';
  const revisionFragment =
    baseOid && baseOid === verifiedHeadOid && !dirty
      ? 'criticRevisionIdentical'
      : baseOid
        ? 'criticRevisionDiff'
        : 'criticRevisionAlone';
  const revisionBlock = renderFragment(revisionFragment, fragments, {
    ticketFirst,
    spec,
    head: verifiedHeadOid,
    base: baseOid ?? '',
    workingTreeNote,
  });
  return `${interpolated}

${revisionBlock}

${renderFragment('criticRole', fragments)}

${renderFragment('criticSecurity', fragments)}

${renderFragment('criticVerdictContract', fragments)}`;
}
