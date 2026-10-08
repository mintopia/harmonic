import type { UpdateState } from '../types.js';
import { versionSkew, type VersionSkew } from '../version-skew-model.js';
import { btnPrimary, btnQuiet } from '../ui.js';
import { CopyButton } from './CopyButton.js';
import { Icon } from './Icon.js';

type BannerActions = {
  pending: boolean;
  onArm: () => void;
  onCancel: () => void;
  onDismiss: () => void;
};

type UpdateBannerProps = BannerActions & {
  update: UpdateState | null;
  /** The version this web bundle was built from; null when unknown. */
  bundleVersion: string | null;
};

function isSelfUpgradeActive(update: UpdateState): boolean {
  return update.upgradingVersion !== null || update.armedVersion !== null || update.failed !== null || update.migrationRequired;
}

function isIdle(update: UpdateState): boolean {
  return update.idle.runningAttempts === 0 && !update.idle.mergingOrIntegrating && !update.idle.conversationMidTurn;
}

function GuardMissingNotice() {
  return (
    <div role="status" className="shrink-0 border-b border-await bg-await-tint px-6 py-1.5 text-label text-ink">
      Automatic rollback is off for this install until you re-run <code>sudo harmonic install</code>.
    </div>
  );
}

function VersionSkewNotice({ skew }: { skew: VersionSkew }) {
  if (skew.kind === 'restart-service') {
    return (
      <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-await bg-await-tint px-6 py-2.5 text-small text-ink">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-await-dot" />
        <p className="min-w-0 flex-1">
          Harmonic v{skew.bundleVersion} is installed, but v{skew.runningVersion} is still running. Restart the Harmonic
          service to finish the upgrade; some pages may not work until then.
        </p>
      </div>
    );
  }
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-ready bg-ready-tint px-6 py-2.5 text-small">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ready-dot" />
      <p className="min-w-0 flex-1 text-ink">Harmonic was updated to v{skew.runningVersion}. Reload this page to use it.</p>
      <button type="button" className={`${btnPrimary} shrink-0`} onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

export function UpdateBanner({ update, bundleVersion, pending, onArm, onCancel, onDismiss }: UpdateBannerProps) {
  if (update === null) return null;
  const skew = isSelfUpgradeActive(update) ? null : versionSkew(bundleVersion, update.currentVersion);

  return (
    <>
      {update.guardMissing && <GuardMissingNotice />}
      {skew !== null ? <VersionSkewNotice skew={skew} /> : primaryBanner({ update, pending, onArm, onCancel, onDismiss })}
    </>
  );
}

function primaryBanner({ update, pending, onArm, onCancel, onDismiss }: BannerActions & { update: UpdateState }) {
  if (update.migrationRequired) {
    return (
      <div role="alert" className="shrink-0 border-b border-await bg-await-tint px-6 py-2.5 text-small text-ink">
        Upgrading from the app is off until you re-run <code>sudo harmonic install</code>, which reuses this
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

  if (update.mode.kind === 'external' && update.mode.instruction !== undefined && update.dismissedVersion !== update.availableVersion) {
    const instruction = update.mode.instruction;
    return (
      <div role="status" className="flex shrink-0 items-center gap-3 border-b border-await bg-await-tint px-6 py-2.5 text-small text-ink">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-await-dot" />
        <p className="min-w-0 flex-1">
          Version {update.availableVersion} is available. This install can't upgrade itself.{' '}
          {instruction.kind === 'command' ? <>To upgrade, run <code>{instruction.command}</code></> : instruction.instructions}
        </p>
        {instruction.kind === 'command' && <CopyButton text={instruction.command} label="Copy command" className="size-11" />}
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
          {update.idle.conversationMidTurn && ' Waiting for an agent to finish its turn before updating.'}
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
