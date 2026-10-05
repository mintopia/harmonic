import type { AppConfig } from '../config.js';
import { expandFragments, fillTemplate, renderFragment, type DriveFields } from '../execution/prompt-template.js';

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
  fragments: AppConfig['promptFragments'];
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
