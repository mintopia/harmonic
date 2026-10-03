import type { TrackerRef } from './types.js';
import { epicLabel } from './id-format.js';
import type {
  AgentMessage,
  AgentMessageReceipt,
  AgentMessageRecipient,
  AgentMessageThread,
  AgentMessageThreadParticipant,
  TaskState,
} from './types.js';

export interface ThreadFilter {
  workspaceId: number | null;
  epicId: TrackerRef | null;
  taskId: number | null;
  liveOnly: boolean;
  query: string;
}

export type ServerThreadFilter = Omit<ThreadFilter, 'query'>;

export const NO_SERVER_FILTER: ServerThreadFilter = { workspaceId: null, epicId: null, taskId: null, liveOnly: false };

export function hasServerFilter(filter: ServerThreadFilter): boolean {
  return filter.workspaceId !== null || filter.epicId !== null || filter.taskId !== null || filter.liveOnly;
}

export const NO_THREAD_FILTER: ThreadFilter = { workspaceId: null, epicId: null, taskId: null, liveOnly: false, query: '' };

export const TIME_SEPARATOR_GAP_MS = 3 * 60_000;
const IDENTITY_COUNT = 3;
const SNIPPET_LENGTH = 80;
const QUOTE_LENGTH = 60;

export type Identity = 1 | 2 | 3;

export function identityFor(participants: readonly AgentMessageThreadParticipant[], taskId: number): Identity | null {
  const index = participants.findIndex((p) => p.taskId === taskId);
  return index < 0 ? null : ((index % IDENTITY_COUNT) + 1) as Identity;
}

export function messageText(message: AgentMessage): string {
  return message.parts.map((part) => part.text).join('\n');
}

export function snippet(text: string, max = SNIPPET_LENGTH): string {
  const line = text.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function threadTitle(thread: AgentMessageThread): string {
  const latest = thread.messages.at(-1);
  return latest ? snippet(messageText(latest)) : 'Empty thread';
}

export function participantLabel(participant: AgentMessageThreadParticipant | undefined, taskId: number): string {
  if (!participant || participant.deleted) return `#${taskId} deleted Task`;
  return participant.title ? `#${taskId} ${participant.title}` : `#${taskId}`;
}

function harnessName(harness: string): string {
  return harness.charAt(0).toUpperCase() + harness.slice(1);
}

/** The Epic every non-deleted participant belongs to, or null when they differ. */
export function commonEpicId(participants: readonly AgentMessageThreadParticipant[]): TrackerRef | null {
  const epics = participants.filter((p) => !p.deleted).map((p) => p.epicId);
  const first = epics[0];
  return first != null && epics.every((e) => e === first) ? first : null;
}

export function threadParticipantsLine(thread: AgentMessageThread): string {
  const names = thread.participants.map((p) =>
    p.deleted ? 'deleted Task' : `#${p.taskId}${p.harness ? ` ${harnessName(p.harness)}` : ''}`,
  );
  const epic = commonEpicId(thread.participants);
  const epicAddressed = thread.messages.some((m) => m.recipients.length > 1);
  return epic !== null && epicAddressed ? `${names.join(' · ')} \u00a0→ Epic #${epic}` : names.join(' · ');
}

export function threadEpicCaption(thread: AgentMessageThread): string {
  const epic = commonEpicId(thread.participants);
  return epic === null ? 'Thread' : `Thread · Epic #${epic}`;
}

function participatesIn(thread: AgentMessageThread, taskId: number): boolean {
  return thread.participants.some((p) => p.taskId === taskId);
}

function matchesQuery(thread: AgentMessageThread, query: string): boolean {
  const haystack = [
    ...thread.messages.map(messageText),
    ...thread.participants.flatMap((p) => [String(p.taskId), `#${p.taskId}`, p.title ?? '', p.harness ?? '']),
  ]
    .join('\n')
    .toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/** Newest activity first; ties break on thread id so the order is stable. */
export function filterThreads(threads: readonly AgentMessageThread[], filter: ThreadFilter): AgentMessageThread[] {
  const query = filter.query.trim().toLowerCase();
  return threads
    .filter((thread) => {
      if (filter.liveOnly && !thread.live) return false;
      if (filter.workspaceId !== null && thread.workspaceId !== filter.workspaceId) return false;
      if (filter.epicId !== null && !thread.participants.some((p) => p.epicId === filter.epicId)) return false;
      if (filter.taskId !== null && !participatesIn(thread, filter.taskId)) return false;
      return query === '' || matchesQuery(thread, query);
    })
    .sort((a, b) => b.latestAt - a.latestAt || (a.threadId < b.threadId ? 1 : -1));
}

export interface WorkspaceOption {
  id: number;
  name: string;
}

export function workspaceOptions(threads: readonly AgentMessageThread[]): WorkspaceOption[] {
  const byId = new Map<number, string>();
  for (const thread of threads) if (!byId.has(thread.workspaceId)) byId.set(thread.workspaceId, thread.workspaceName);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

export function showWorkspaceBadge(global: boolean, filter: Pick<ServerThreadFilter, 'workspaceId'>): boolean {
  return global && filter.workspaceId === null;
}

export interface EpicOption {
  key: string;
  workspaceId: number;
  epicId: TrackerRef;
  label: string;
}

export function epicKey(workspaceId: number, epicId: TrackerRef): string {
  return `${workspaceId}:${epicId}`;
}

/** Epic ids are per Workspace, so options are keyed by both; `prefixed` adds the Workspace name. */
export function epicOptions(threads: readonly AgentMessageThread[], workspaceId: number | null = null, prefixed = false): EpicOption[] {
  const byKey = new Map<string, EpicOption & { workspaceName: string }>();
  for (const thread of threads) {
    if (workspaceId !== null && thread.workspaceId !== workspaceId) continue;
    for (const p of thread.participants) {
      if (p.epicId == null) continue;
      const key = epicKey(thread.workspaceId, p.epicId);
      if (byKey.has(key)) continue;
      const label = `${prefixed ? `${thread.workspaceName} · ` : ''}${epicLabel(p.epicId)}`;
      byKey.set(key, { key, workspaceId: thread.workspaceId, epicId: p.epicId, label, workspaceName: thread.workspaceName });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.workspaceId - b.workspaceId || a.epicId.localeCompare(b.epicId, undefined, { numeric: true }))
    .map(({ workspaceName: _name, ...option }) => option);
}

export interface TaskOption {
  taskId: number;
  label: string;
}

export function taskOptions(threads: readonly AgentMessageThread[], epicId: TrackerRef | null, workspaceId: number | null = null): TaskOption[] {
  const byId = new Map<number, TaskOption>();
  for (const thread of threads) {
    if (workspaceId !== null && thread.workspaceId !== workspaceId) continue;
    for (const p of thread.participants) {
      if (p.deleted || byId.has(p.taskId)) continue;
      if (epicId !== null && p.epicId !== epicId) continue;
      byId.set(p.taskId, { taskId: p.taskId, label: participantLabel(p, p.taskId) });
    }
  }
  return [...byId.values()].sort((a, b) => a.taskId - b.taskId);
}

export function totalMessages(threads: readonly AgentMessageThread[]): number {
  return threads.reduce((sum, thread) => sum + thread.messages.length, 0);
}

export interface ThreadsView {
  threads: AgentMessageThread[];
  total: number;
  totalMessages: number;
}

export function countLine(threads: number, messages: number): string {
  return `${threads} ${threads === 1 ? 'thread' : 'threads'} · ${messages} ${messages === 1 ? 'message' : 'messages'}`;
}

export function threadsCapHint(shown: number, total: number): string | null {
  return total > shown ? `Showing ${shown} of ${total} threads` : null;
}

export const THREAD_PAGE_SIZE = 200;

export function nextPageCount(pageCount: number, total: number): number {
  return total > pageCount * THREAD_PAGE_SIZE ? pageCount + 1 : pageCount;
}

export function mergeThreadPages(pages: readonly ThreadsView[]): ThreadsView {
  const last = pages[pages.length - 1];
  const seen = new Set<string>();
  const threads = pages.flatMap((page) => page.threads).filter((t) => !seen.has(t.threadId) && seen.add(t.threadId));
  return { threads, total: last?.total ?? 0, totalMessages: last?.totalMessages ?? 0 };
}

/** Index to focus so Tab stays inside a modal drawer; -1 means focus is outside it. Null lets the browser move focus. */
export function trappedFocusIndex(current: number, count: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (current === -1) return backwards ? count - 1 : 0;
  if (!backwards && current === count - 1) return 0;
  if (backwards && current === 0) return count - 1;
  return null;
}

export function resolveSelectedThread(threads: readonly AgentMessageThread[], threadId: string | null): AgentMessageThread | null {
  return threads.find((t) => t.threadId === threadId) ?? threads[0] ?? null;
}

export interface Receipt {
  taskId: number;
  label: string;
  showLabel: boolean;
  state: AgentMessageReceipt;
  tick: string;
  describe: string;
  tail: string;
}

export interface QuotedReply {
  sender: string;
  time: string;
  text: string;
}

export interface TranscriptMessage {
  id: string;
  text: string;
  quote: QuotedReply | null;
  to: string;
  receipts: Receipt[];
}

export interface TranscriptGroup {
  kind: 'group';
  key: string;
  senderTaskId: number;
  senderAttemptNumber: number | null;
  identity: Identity | null;
  name: string;
  harness: string | null;
  harnessLabel: string;
  attemptLabel: string | null;
  time: string;
  messages: TranscriptMessage[];
}

export interface TranscriptSeparator {
  kind: 'day' | 'time';
  key: string;
  label: string;
}

export type TranscriptItem = TranscriptGroup | TranscriptSeparator;

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function clockSeconds(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(at: number, now: number): string {
  if (dayKey(at) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday.getTime())) return 'Yesterday';
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

const TICKS: Record<AgentMessageReceipt, string> = { queued: '✓', delivered: '✓✓', held: '◷', refused: '✕' };

function describeReceipt(r: AgentMessageRecipient): string {
  switch (r.receipt) {
    case 'queued':
      return 'queued for next turn';
    case 'delivered':
      return r.mode === 'mid-turn' ? 'delivered mid-turn' : r.mode === 'next-turn' ? 'delivered next turn' : 'delivered';
    case 'held':
      return 'held until next Attempt';
    case 'refused':
      return r.reason ? `refused: ${r.reason}` : 'refused';
  }
}

function receiptTail(r: AgentMessageRecipient, single: boolean): string {
  if (r.receipt === 'refused') return r.reason ? `refused: ${r.reason}` : 'refused';
  if (!single) return r.reason ?? '';
  const parts: string[] = [];
  if (r.receipt === 'delivered' && r.mode) parts.push(r.mode);
  if (r.receipt !== 'delivered' && r.deliveredAt !== undefined) parts.push(`delivered ${clockSeconds(r.deliveredAt)}`);
  if (r.reason) parts.push(r.reason);
  return parts.join(' · ');
}

export function receiptsFor(message: AgentMessage): Receipt[] {
  const single = message.recipients.length === 1;
  return message.recipients.map((r) => ({
    taskId: r.taskId,
    label: r.deleted ? 'deleted Task' : `#${r.taskId}`,
    showLabel: !single,
    state: r.receipt,
    tick: TICKS[r.receipt],
    describe: describeReceipt(r),
    tail: receiptTail(r, single),
  }));
}

function addressee(message: AgentMessage, participants: readonly AgentMessageThreadParticipant[]): string {
  if (message.recipients.length <= 1) return `#${message.recipients[0]?.taskId ?? ''}`;
  const epic = commonEpicId(participants.filter((p) => message.recipients.some((r) => r.taskId === p.taskId)));
  return epic === null ? `${message.recipients.length} Tasks` : `Epic #${epic}`;
}

function senderName(message: AgentMessage): string {
  return message.senderDeleted ? 'deleted Task' : `#${message.senderTaskId}`;
}

function quoteFor(message: AgentMessage, thread: AgentMessageThread): QuotedReply | null {
  if (message.replyTo === null) return null;
  const parent = thread.messages.find((m) => m.messageId === message.replyTo);
  if (!parent) return null;
  return { sender: senderName(parent), time: clockTime(parent.createdAt), text: snippet(messageText(parent), QUOTE_LENGTH) };
}

export function segmentThread(thread: AgentMessageThread, now: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let current: TranscriptGroup | null = null;
  let previous: AgentMessage | null = null;
  for (const message of thread.messages) {
    let broke = false;
    if (previous === null || dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
      items.push({ kind: 'day', key: `day-${message.messageId}`, label: dayLabel(message.createdAt, now) });
      broke = true;
    } else if (message.createdAt - previous.createdAt >= TIME_SEPARATOR_GAP_MS) {
      items.push({ kind: 'time', key: `time-${message.messageId}`, label: clockTime(message.createdAt) });
      broke = true;
    }
    if (broke || current === null || current.senderTaskId !== message.senderTaskId || current.senderAttemptNumber !== message.senderAttemptNumber) {
      const sender = thread.participants.find((p) => p.taskId === message.senderTaskId);
      current = {
        kind: 'group',
        key: `group-${message.messageId}`,
        senderTaskId: message.senderTaskId,
        senderAttemptNumber: message.senderAttemptNumber,
        identity: identityFor(thread.participants, message.senderTaskId),
        name: participantLabel(message.senderDeleted && sender ? { ...sender, deleted: true } : sender, message.senderTaskId),
        harness: sender?.harness ?? null,
        harnessLabel: sender?.harness ? harnessName(sender.harness) : '',
        attemptLabel: message.senderAttemptNumber === null ? null : `Attempt ${message.senderAttemptNumber}`,
        time: clockTime(message.createdAt),
        messages: [],
      };
      items.push(current);
    }
    current.messages.push({
      id: message.messageId,
      text: messageText(message),
      quote: quoteFor(message, thread),
      to: addressee(message, thread.participants),
      receipts: receiptsFor(message),
    });
    previous = message;
  }
  return items;
}

export type BodyPart = { code: boolean; value: string };

export function bodyParts(text: string): BodyPart[] {
  return text
    .split(/(`[^`\n]+`)/)
    .filter((value) => value !== '')
    .map((value) => (value.length > 2 && value.startsWith('`') && value.endsWith('`') ? { code: true, value: value.slice(1, -1) } : { code: false, value }));
}

export type ActivityTab = 'running' | 'messages';

export function parseActivityTab(id: string): ActivityTab {
  return id === 'messages' ? 'messages' : 'running';
}

export function resolveActivityTab(tab: ActivityTab, messagesEnabled: boolean): ActivityTab {
  return messagesEnabled ? tab : 'running';
}

export interface AgentCard {
  taskId: number;
  identity: Identity | null;
  deleted: boolean;
  harness: string | null;
  harnessLabel: string;
  title: string;
  model: string | null;
  state: TaskState | null;
  betweenAttempts: boolean;
  attemptLabel: string | null;
  sendsCount: string;
  sendsRatio: number;
  atCap: boolean;
  lastMessage: string;
}

export function agentCards(thread: AgentMessageThread): AgentCard[] {
  return thread.participants.map((p) => {
    const atCap = p.sends >= p.sendCap;
    return {
      taskId: p.taskId,
      identity: identityFor(thread.participants, p.taskId),
      deleted: p.deleted,
      harness: p.harness,
      harnessLabel: p.harness ? harnessName(p.harness) : '',
      title: p.deleted ? 'deleted Task' : (p.title ?? ''),
      model: p.model,
      state: p.state,
      betweenAttempts: p.betweenAttempts,
      attemptLabel: p.attemptNumber === null ? null : `Attempt ${p.attemptNumber}`,
      sendsCount: `${p.sends}/${p.sendCap}`,
      sendsRatio: p.sendCap > 0 ? Math.min(1, p.sends / p.sendCap) : atCap ? 1 : 0,
      atCap,
      lastMessage: p.lastMessageAt === null ? 'none sent' : clockTime(p.lastMessageAt),
    };
  });
}
