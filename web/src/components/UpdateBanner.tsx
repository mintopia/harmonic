import type { UpdateState } from '../types.js';
import { btnPrimary, btnQuiet } from '../ui.js';

type UpdateBannerProps = {
  update: UpdateState | null;
  pending: boolean;
  onArm: () => void;
  onCancel: () => void;
  onDismiss: () => void;
};

function isIdle(update: UpdateState): boolean {
  return update.idle.runningAttempts === 0 && !update.idle.mergingOrIntegrating && !update.idle.conversationMidTurn;
}

export function UpdateBanner({ update, pending, onArm, onCancel, onDismiss }: UpdateBannerProps) {
  if (update === null) return null;

  if (update.armedVersion !== null) {
    if (isIdle(update)) {
      return (
        <div role="status" className="shrink-0 border-b border-ready bg-ready-tint px-6 py-2.5 text-small text-ink">
          Updating to version {update.armedVersion}…
        </div>
      );
    }

    return (
      <div role="status" className="flex shrink-0 items-center gap-3 border-b border-running bg-running-tint px-6 py-2.5 text-small">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-running-dot" />
        <p className="min-w-0 flex-1 text-ink">
          Version {update.armedVersion} will restart when Harmonic is idle.
          {update.idle.conversationMidTurn && ' waiting for agent before updating.'}
        </p>
        <button type="button" className={`${btnQuiet} shrink-0`} disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  if (update.availableVersion === null || update.dismissedVersion === update.availableVersion) return null;

  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-ready bg-ready-tint px-6 py-2.5 text-small">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ready-dot" />
      <p className="min-w-0 flex-1 text-ink">Version {update.availableVersion} is available.</p>
      <button type="button" className={`${btnPrimary} shrink-0`} disabled={pending} onClick={onArm}>
        Upgrade
      </button>
      <button type="button" className={`${btnQuiet} shrink-0`} disabled={pending} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
