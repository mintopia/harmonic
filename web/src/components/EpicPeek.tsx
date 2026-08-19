import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Epic, EpicMember, LandOutcomeBanner, LandOutcomeBannerTone, RailSegmentStatus } from '../epic-model';
import {
  FORCE_LAND_CONSEQUENCE,
  ROSTER_LANES,
  ROSTER_LANE_LABELS,
  landOutcomeBanner,
  memberRailStatus,
  railSegments,
  rosterLanes,
  statusLine,
} from '../epic-model';
import { toastError } from '../toast';
import { btnQuiet, btnQuietDestructive, chip, escalatedChip, labelType, panelTitle } from '../ui';
import { ArmedButton } from './ArmedButton';
import { Modal } from './Modal';

/** Rail/roster status → its plain-text label (colourblind safety: text names
 * the state everywhere colour is used, never colour alone). */
const RAIL_LABEL: Record<RailSegmentStatus, string> = {
  landed: 'landed',
  running: 'running',
  healing: 'healing',
  waiting: 'waiting',
  blocking: 'blocking',
};

/** Rail/roster status → tint/ink pair, reusing the app's existing state
 * vocabulary (ui.ts's tint/ink chip pairs) rather than minting new colour. */
const RAIL_TONE: Record<RailSegmentStatus, string> = {
  landed: 'bg-accept-tint text-accept',
  running: 'bg-running-tint text-running',
  healing: 'bg-running-tint text-running',
  waiting: 'bg-raised text-muted',
  blocking: 'bg-fail-tint text-fail',
};

const BANNER_TONE: Record<LandOutcomeBannerTone, string> = {
  ok: 'bg-accept-tint text-accept',
  warn: 'bg-running-tint text-running',
  bad: 'bg-fail-tint text-fail',
  info: 'bg-raised text-muted',
};

/** How long the transient force-land outcome banner stays up before it
 * auto-dismisses (mirrors the toast stack's 6s window in toast.tsx). */
const BANNER_TIMEOUT_MS = 6000;

/** The landing rail (ADR-0026's peek hero): members as segments coloured by
 * land status, motion (a pulse) reserved for a live heal (`hasLiveHeal`). */
function LandingRail({ epic }: { epic: Epic }) {
  const segments = railSegments(epic);
  return (
    <div className="flex gap-1">
      {segments.map((seg) => (
        <div key={seg.ref} className="min-w-0 flex-1">
          <div
            title={`#${seg.ref} — ${RAIL_LABEL[seg.status]}`}
            className={`flex h-8 items-center justify-center rounded-md text-label font-semibold tabular-nums ${RAIL_TONE[seg.status]} ${
              seg.status === 'healing' ? 'motion-safe:animate-pulse' : ''
            }`}
          >
            #{seg.ref}
          </div>
          <div className="mt-1 truncate text-center text-label text-faint">{RAIL_LABEL[seg.status]}</div>
        </div>
      ))}
    </div>
  );
}

/** One roster row: ref, title, escalation flag, and land status — a deep-link
 * button into the member's existing TaskDetail when it's mirrored, else a
 * static row (the member hasn't been mirrored into a Task yet). */
function MemberRow({
  member,
  epic,
  onOpenTask,
}: {
  member: EpicMember;
  epic: Epic;
  onOpenTask: (taskId: number) => void;
}) {
  const status = memberRailStatus(member, epic);
  const body = (
    <>
      <span className="w-12 shrink-0 font-data text-small tabular-nums text-muted">#{member.ref}</span>
      <span className="min-w-0 flex-1 truncate text-ink">{member.title || '—'}</span>
      {member.escalated && <span className={`${escalatedChip} shrink-0`}>escalated</span>}
      <span className={`${chip} shrink-0 ${RAIL_TONE[status]}`}>{RAIL_LABEL[status]}</span>
    </>
  );
  if (member.taskId == null) {
    return <div className="flex items-center gap-2.5 rounded-md bg-raised px-2.5 py-2">{body}</div>;
  }
  const taskId = member.taskId;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-md bg-raised px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface hover:ring-1 hover:ring-edge"
      onClick={() => onOpenTask(taskId)}
    >
      {body}
      <span aria-hidden="true" className="shrink-0 text-faint">
        →
      </span>
    </button>
  );
}

/**
 * The Epic peek (ADR-0026, issue #167): a Modal mirroring TaskDetail's usage.
 * Hero = the landing rail + status line; below it the stuck-first roster,
 * lane-grouped; the header carries the armed force-land control and a
 * "Focus on board" affordance. Force-land's result renders as a transient
 * in-peek banner (`landOutcomeBanner`), auto-dismissing after a few seconds.
 */
export function EpicPeek({
  epic,
  workspaceId,
  onOpenTask,
  onFocus,
  onClose,
  onChanged,
}: {
  epic: Epic;
  workspaceId: number;
  onOpenTask: (taskId: number) => void;
  onFocus: (epicRef: number) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [banner, setBanner] = useState<LandOutcomeBanner | null>(null);

  // The peek can stay open across an Epic refetch (onChanged upstream); a
  // stale banner from a *previous* force-land attempt shouldn't linger once
  // the operator has moved on to inspecting a different Epic.
  useEffect(() => {
    setBanner(null);
  }, [epic.ref]);

  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), BANNER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  const handleForceLand = () => {
    api.forceLandEpic(workspaceId, epic.ref).then((outcome) => {
      setBanner(landOutcomeBanner(outcome));
      onChanged();
    }, toastError);
  };

  const lanes = rosterLanes(epic);

  return (
    <Modal label={`Epic #${epic.ref}`} onClose={onClose} className="max-w-2xl">
      <div className="flex max-h-[85vh] flex-col">
        <header className="border-b border-hairline p-4">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2 text-small text-muted">
                <span className={`${chip} bg-raised text-muted`}>{epic.kind}</span>
                <span>Epic #{epic.ref}</span>
              </div>
              <h2 className={panelTitle}>{epic.title}</h2>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <ArmedButton
                label="Force-land ready subset"
                armedLabel="Confirm force-land"
                ariaLabel={`Force-land Epic #${epic.ref}`}
                className={btnQuietDestructive}
                onConfirm={handleForceLand}
              />
              <p className="max-w-[220px] text-right text-label text-faint">{FORCE_LAND_CONSEQUENCE}.</p>
            </div>
          </div>
          <button type="button" className={`${btnQuiet} mt-3`} onClick={() => onFocus(epic.ref)}>
            Focus on board →
          </button>
          {banner && (
            <div role="status" className={`mt-3 rounded-md px-3 py-2 text-small ${BANNER_TONE[banner.tone]}`}>
              {banner.text}
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <div className={`${labelType} mb-1.5 text-muted`}>Landing rail</div>
          <LandingRail epic={epic} />
          <div className="mt-2 font-data text-small text-muted">{statusLine(epic)}</div>

          <div className="mt-6 flex flex-col gap-5">
            {ROSTER_LANES.map((lane) => {
              const members = lanes[lane];
              if (members.length === 0) return null;
              return (
                <div key={lane}>
                  <div className={`${labelType} mb-1.5 text-muted`}>
                    {ROSTER_LANE_LABELS[lane]} <span className="text-faint">· {members.length}</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {members.map((m) => (
                      <MemberRow key={m.ref} member={m} epic={epic} onOpenTask={onOpenTask} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
