import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Epic, EpicMember, LandOutcomeBanner, LandOutcomeBannerTone } from '../epic-model';
import {
  FORCE_LAND_CONSEQUENCE,
  ROSTER_LANES,
  ROSTER_LANE_LABELS,
  landOutcomeBanner,
  memberRailStatus,
  rosterLanes,
  statusLineParts,
} from '../epic-model';
import { toastError } from '../toast';
import { btnQuiet, btnQuietDestructive, chip, escalatedChip, labelType, panelTitle } from '../ui';
import { ArmedButton } from './ArmedButton';
import { Modal } from './Modal';

const BANNER_TONE: Record<LandOutcomeBannerTone, string> = {
  ok: 'bg-merged-tint text-merged',
  warn: 'bg-running-tint text-running',
  bad: 'bg-fail-tint text-fail',
  info: 'bg-raised text-muted',
};

const BANNER_TIMEOUT_MS = 6000;

function memberStatusLabel(status: ReturnType<typeof memberRailStatus>): string {
  switch (status) {
    case 'landed': return 'merged';
    case 'running': return 'running';
    case 'healing': return 'healing';
    case 'waiting': return 'waiting';
    case 'blocking': return 'blocking';
  }
}

function memberStatusTone(status: ReturnType<typeof memberRailStatus>): string {
  switch (status) {
    case 'landed': return 'bg-merged-tint text-merged';
    case 'running':
    case 'healing': return 'bg-running-tint text-running';
    case 'waiting': return 'bg-raised text-muted';
    case 'blocking': return 'bg-fail-tint text-fail';
  }
}

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
      <span className={`${chip} shrink-0 ${memberStatusTone(status)}`}>{memberStatusLabel(status)}</span>
    </>
  );
  if (member.taskId == null) {
    return <div className="flex items-center gap-2.5 rounded-md bg-raised px-2.5 py-2">{body}</div>;
  }
  const taskId = member.taskId;
  return (
    <button
      type="button"
      className="flex min-h-11 w-full items-center gap-2.5 rounded-md bg-raised px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface hover:ring-1 hover:ring-edge"
      onClick={() => onOpenTask(taskId)}
    >
      {body}
      <span aria-hidden="true" className="shrink-0 text-faint">
        →
      </span>
    </button>
  );
}

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
            Focus on board <span aria-hidden="true">→</span>
          </button>
          {banner && (
            <div aria-atomic="true" aria-live="assertive" className={`mt-3 rounded-md px-3 py-2 text-small ${BANNER_TONE[banner.tone]}`}>
              {banner.text}
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {(() => {
            const s = statusLineParts(epic);
            return (
              <div className="mt-2 text-small text-muted tabular-nums">
                <span className="font-data">{s.ref}</span> @ <span className="font-data">{s.tip}</span> ·
                verification {s.verification} · {s.foldedCount}/{s.memberCount} merged
              </div>
            );
          })()}

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
