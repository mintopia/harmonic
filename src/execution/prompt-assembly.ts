import { findInterpolations, interpolate, type ExpressionContext } from '../domain/workflow-expression.js';
import { CRITIC_VERDICT_CONTRACT, READ_ONLY_RESTRAINT, type EnginePrompts } from '../domain/bundled-prompts.js';
import type { ClassifierInput } from '../domain/route-classifier.js';
import { codeIndexRepoGuidance, expandIncludes, fillTemplate, renderPrompt, type DriveFields } from './prompt-template.js';

const criticRole = (prompts: EnginePrompts): string => renderPrompt('criticRole', prompts, { readOnlyRestraint: READ_ONLY_RESTRAINT });

const harnessLabel = (harness: string): string => harness.charAt(0).toUpperCase() + harness.slice(1);

export const composePauseMessage = (template: string, prompts: EnginePrompts): string => expandIncludes(template, prompts);

export interface PeerEntry {
  taskId: number;
  harness: string;
  text: string;
}

/** Names the sending Task so the Agent never mistakes it for an operator instruction. */
export function peerFrame(sender: { id: number; harness: string }, text: string, prompts: EnginePrompts): string {
  return renderPrompt('peerLiveMessage', prompts, { taskId: sender.id, harness: harnessLabel(sender.harness), text });
}

function peerMessagesSection(held: readonly PeerEntry[], prompts: EnginePrompts): string {
  const entries = held.map((entry) =>
    renderPrompt('peerMessage', prompts, { taskId: entry.taskId, harness: harnessLabel(entry.harness), text: entry.text }),
  );
  return renderPrompt('peerMessages', prompts, { messages: entries.join('\n\n') });
}

export function composePeerContext(held: readonly PeerEntry[], prompts: EnginePrompts): string {
  const parts: string[] = [];
  if (held.length > 0) parts.push(peerMessagesSection(held, prompts));
  parts.push(renderPrompt('peerLine', prompts));
  return parts.join('\n\n');
}

export interface AttemptPromptInput {
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

export function composeAttemptPrompt(input: AttemptPromptInput, prompts: EnginePrompts): string {
  const operatorSection = (seed: string) => renderPrompt('operatorMessage', prompts, { seed });
  const { seed, heal } = input;
  let text = input.opening;
  let condensed: string | null = null;
  if (seed !== undefined && !heal) {
    if (input.seedMode === 'replace-all') text = operatorSection(seed);
    else text = `${input.freshSessionContext ?? text}\n\n${operatorSection(seed)}`;
  } else if (heal) {
    text = `${text}\n\n${renderPrompt('selfHeal', prompts, { attempt: heal.attempt, reason: heal.reason, output: heal.output })}`;
    condensed = input.condensed;
    if (seed !== undefined) text = `${text}\n\n${operatorSection(seed)}`;
  } else {
    condensed = input.condensed;
  }
  if (input.peerText) text = `${text}\n\n${input.peerText}`;
  if (input.rebaseConflict) text = `${text}\n\n${renderPrompt('rebaseConflict', prompts)}`;
  if (condensed) text = `${text}\n\n${condensed}`;
  if (input.codeIndexRepoId) text = `${text}${codeIndexRepoGuidance(input.codeIndexRepoId, prompts)}`;
  return text;
}

export interface ConflictPromptContext {
  turn: number;
  baseBranch: string;
  taskBranch: string;
  unmergedPaths: string[];
  baseDir: string;
}

const expandAndFill = (template: string, prompts: EnginePrompts, fields: Record<string, string | number>): string =>
  fillTemplate(expandIncludes(template, prompts), fields);

/** Render a conflict-resolution turn prompt from its configured template, expanding included prompts and filling the merge placeholders. */
export function renderConflictPrompt(template: string, prompts: EnginePrompts, ctx: ConflictPromptContext): string {
  return expandAndFill(template, prompts, {
    turn: ctx.turn,
    taskBranch: ctx.taskBranch,
    baseBranch: ctx.baseBranch,
    baseDir: ctx.baseDir,
    paths: ctx.unmergedPaths.map((path) => `- ${path}`).join('\n'),
  });
}

export function renderEpicRefreshPrompt(
  template: string,
  prompts: EnginePrompts,
  ctx: { defaultBranch: string; branch: string; detail: string; worktreePath: string },
): string {
  return expandAndFill(template, prompts, {
    defaultBranch: ctx.defaultBranch,
    branch: ctx.branch,
    detail: ctx.detail,
    baseDir: ctx.worktreePath,
    // The Conflict resolution prompt merges baseBranch into taskBranch; a refresh merges the default branch into the Epic branch.
    baseBranch: ctx.branch,
    taskBranch: ctx.defaultBranch,
  });
}

export interface BuildCriticPromptArgs {
  /** The operator's configured critic prompt; supports the Drive Prompt's
   * `{taskId}/{skill}/{ref}/{url}/{title}/{description}` interpolation. */
  operatorPrompt: string;
  fields: DriveFields;
  /** The candidate revision the worktree is checked out at. */
  verifiedHeadOid: string;
  /** The base revision the candidate diverged from; absent ⇒ the critic reviews the candidate alone. */
  baseOid?: string;
  /** True when the worktree still carries uncommitted work on top of {@link verifiedHeadOid}, pending a
   * pre-merge commit — the true candidate is the working tree, not the `verifiedHeadOid` commit alone. */
  dirty?: boolean;
  prompts: EnginePrompts;
}

/** Build the critic's review prompt: operator prompt, revision block, restraint instruction, output contract. Pure, so the settings preview renders the same compiled prompt. */
export function buildCriticPrompt({
  operatorPrompt,
  fields,
  verifiedHeadOid,
  baseOid,
  dirty,
  prompts,
}: BuildCriticPromptArgs): string {
  const hasTicket = fields.ref.trim() !== '' || fields.url.trim() !== '';
  const interpolated = fillTemplate(expandIncludes(operatorPrompt, prompts), fields);
  const spec = renderPrompt(hasTicket ? 'criticSpecTicket' : 'criticSpecInstructions', prompts);
  const ticketFirst = renderPrompt(hasTicket ? 'criticTicketFirst' : 'criticInstructionsFirst', prompts);
  const workingTreeNote = dirty
    ? ` ${renderPrompt('criticWorkingTreeNote', prompts, { head: verifiedHeadOid, base: baseOid ?? verifiedHeadOid })}`
    : '';
  const revisionCode =
    baseOid && baseOid === verifiedHeadOid && !dirty
      ? 'criticRevisionIdentical'
      : baseOid
        ? 'criticRevisionDiff'
        : 'criticRevisionAlone';
  const revisionBlock = renderPrompt(revisionCode, prompts, {
    ticketFirst,
    spec,
    head: verifiedHeadOid,
    base: baseOid ?? '',
    workingTreeNote,
  });
  return `${interpolated}

${revisionBlock}

${criticRole(prompts)}

${renderPrompt('criticSecurity', prompts)}

${CRITIC_VERDICT_CONTRACT}`;
}

const FINDINGS_NOTE = 'You may add an optional "findings" key to that object: an array of short strings, one per concrete problem you found.';

/** The prompt a workflow critic step sends: the step's own prompt, then the engine's read-only restraint and JSON verdict contract. Neither is editable. */
export function buildWorkflowCriticPrompt(prompt: string, prompts: EnginePrompts): string {
  return [
    prompt,
    `## Critic instructions\n${criticRole(prompts)}`,
    renderPrompt('criticSecurity', prompts),
    CRITIC_VERDICT_CONTRACT,
    FINDINGS_NOTE,
  ].join('\n\n');
}

export function buildClassifierPrompt(input: ClassifierInput, prompts: EnginePrompts): string {
  const { options, ...ticket } = input;
  return renderPrompt('routeClassifier', prompts, {
    options: options.map((o) => `- ${o.id}: ${o.description} (${o.harness} ${o.model})`).join('\n'),
    ticket: JSON.stringify(ticket, null, 2),
  });
}

/** Single pass, so Ticket text can never inject a placeholder. */
export function renderAgentPrompt(text: string, fields: Record<string, string | number>, context?: ExpressionContext): string {
  const spans = context ? findInterpolations(text) : [];
  let out = '';
  let last = 0;
  for (const span of spans) {
    out += fillTemplate(text.slice(last, span.start), fields) + interpolate(text.slice(span.start, span.end), context!);
    last = span.end;
  }
  return out + fillTemplate(text.slice(last), fields);
}
