import { useEffect, useRef, useState } from 'react';
import type { UpdateState } from '../types.js';
import { btnPrimary, btnQuiet } from '../ui.js';
import { Icon } from './Icon.js';

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

function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.warn('clipboard copy failed', e);
    }
  };
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy command'}
      onClick={copy}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded text-faint transition-colors duration-150 hover:text-ink ${copied ? 'text-merged' : ''}`}
    >
      <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
    </button>
  );
}

function GuardMissingNotice() {
  return (
    <div role="status" className="shrink-0 border-b border-await bg-await-tint px-6 py-1.5 text-label text-ink">
      Automatic rollback is off for this install until you re-run <code>sudo harmonic install</code>.
    </div>
  );
}

export function UpdateBanner({ update, pending, onArm, onCancel, onDismiss }: UpdateBannerProps) {
  if (update === null) return null;

  return (
    <>
      {update.guardMissing && <GuardMissingNotice />}
      {primaryBanner({ update, pending, onArm, onCancel, onDismiss })}
    </>
  );
}

function primaryBanner({ update, pending, onArm, onCancel, onDismiss }: UpdateBannerProps & { update: UpdateState }) {
  if (update.migrationRequired) {
    return (
      <div role="alert" className="shrink-0 border-b border-await bg-await-tint px-6 py-2.5 text-small text-ink">
        Auto-upgrade is disabled until you re-run <code>sudo harmonic install</code>, which reuses this
        service's existing port, host, data directory, and password.
      </div>
    );
  }

  if (update.failed !== null) {
    return (
      <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-fail bg-fail-tint px-6 py-2.5 text-small text-ink">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-fail" />
        <p className="min-w-0 flex-1">
          Update to v{update.failed.targetVersion} did not complete ({update.failed.reason}). Still running v{update.currentVersion}.
        </p>
        <button type="button" className={`${btnPrimary} shrink-0`} disabled={pending} onClick={onArm}>
          Try again
        </button>
      </div>
    );
  }

  if (update.mode.kind === 'external' && update.mode.command !== undefined && update.dismissedVersion !== update.availableVersion) {
    return (
      <div role="status" className="flex shrink-0 items-center gap-3 border-b border-await bg-await-tint px-6 py-2.5 text-small text-ink">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-await-dot" />
        <p className="min-w-0 flex-1">
          Version {update.availableVersion} is available. Auto-upgrade isn't available for this install — run: <code>{update.mode.command}</code>
        </p>
        <CopyCommandButton command={update.mode.command} />
        <button type="button" className={`${btnQuiet} shrink-0`} disabled={pending} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  if (update.upgradingVersion !== null) {
    return (
      <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-3 border-b-2 border-running bg-running-tint px-6 py-4 text-body text-ink shadow-sm">
        <Icon name="refresh" className="size-5 shrink-0 text-running motion-safe:animate-spin" />
        <p className="min-w-0 flex-1 font-semibold">
          Updating to v{update.upgradingVersion} — Harmonic will restart, this page reconnects automatically.
        </p>
      </div>
    );
  }

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
