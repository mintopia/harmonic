import { Modal } from './Modal';
import { btnGhost, btnPrimary, btnQuiet, panelTitle } from '../ui';
import type { UpdateState } from '../types';

const DOCS_URL = 'https://mintopia.github.io/harmonic';
const REPO_URL = 'https://github.com/mintopia/harmonic';
const AUTHOR_URL = 'https://github.com/mintopia';
const SITE_URL = 'https://mintopia.net';

const EXTERNAL_LINK_CLASS = 'text-accent underline-offset-2 hover:underline';

interface AboutOverlayProps {
  appName: string;
  currentVersion: string | null;
  update: UpdateState | null;
  pending: boolean;
  onArm: () => void;
  onCheckForUpdates: () => void;
  onClose: () => void;
}

function isIdle(update: UpdateState): boolean {
  return update.idle.runningAttempts === 0 && !update.idle.mergingOrIntegrating && !update.idle.conversationMidTurn;
}

function UpdateSection({ update, pending, onArm, onCheckForUpdates }: Pick<AboutOverlayProps, 'update' | 'pending' | 'onArm' | 'onCheckForUpdates'>) {
  if (update === null) return null;

  if (update.armedVersion !== null) {
    return (
      <p className="mt-4 text-small text-muted">
        {isIdle(update)
          ? `Updating to version ${update.armedVersion}…`
          : `Version ${update.armedVersion} will restart when Harmonic is idle.`}
      </p>
    );
  }

  return (
    <div className="mt-4 flex items-center gap-2">
      {update.availableVersion !== null && (
        <button type="button" className={`${btnPrimary} px-3 py-1.5`} disabled={pending} onClick={onArm}>
          Upgrade to {update.availableVersion}
        </button>
      )}
      <button type="button" className={`${btnGhost} px-3 py-1.5`} disabled={pending} onClick={onCheckForUpdates}>
        Check for updates
      </button>
    </div>
  );
}

export function AboutOverlay({ appName, currentVersion, update, pending, onArm, onCheckForUpdates, onClose }: AboutOverlayProps) {
  return (
    <Modal label="About" onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-2 pr-6`}>{appName}</h2>
        <p className="text-small text-muted">{currentVersion !== null ? `Version ${currentVersion}` : 'Checking version…'}</p>
        <ul className="mt-4 flex flex-col gap-1.5 text-body">
          <li>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={EXTERNAL_LINK_CLASS}>
              Documentation
            </a>
          </li>
          <li>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={EXTERNAL_LINK_CLASS}>
              GitHub repo
            </a>
          </li>
          <li>
            <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer" className={EXTERNAL_LINK_CLASS}>
              @mintopia on GitHub
            </a>
          </li>
          <li>
            <a href={SITE_URL} target="_blank" rel="noopener noreferrer" className={EXTERNAL_LINK_CLASS}>
              mintopia.net
            </a>
          </li>
        </ul>
        <UpdateSection update={update} pending={pending} onArm={onArm} onCheckForUpdates={onCheckForUpdates} />
        <div className="mt-5 flex justify-end">
          <button type="button" className={`${btnQuiet}`} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
