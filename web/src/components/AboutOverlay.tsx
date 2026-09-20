import { Modal } from './Modal';
import { Icon, type IconName } from './Icon';
import { btnPrimary } from '../ui';
import type { UpdateState } from '../types';

const DOCS_URL = 'https://mintopia.github.io/harmonic';
const REPO_URL = 'https://github.com/mintopia/harmonic';
const AUTHOR_URL = 'https://github.com/mintopia';
const SITE_URL = 'https://mintopia.net';

const LINKS: { href: string; icon: IconName; label: string; hint: string }[] = [
  { href: DOCS_URL, icon: 'book', label: 'Documentation', hint: 'Guides & reference' },
  { href: REPO_URL, icon: 'github', label: 'Source', hint: 'mintopia/harmonic' },
  { href: AUTHOR_URL, icon: 'user', label: 'Author', hint: '@mintopia' },
  { href: SITE_URL, icon: 'globe', label: 'Website', hint: 'mintopia.net' },
];

// The header band is intentionally dark in BOTH themes, so its lettering and mark
// use fixed on-dark values rather than theme tokens (which would flip to dark ink
// in Daylight and vanish against the band).
const BAND_TEAL = '#2ED3C4';

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

interface NoteMoteConfig {
  left: number;
  bottom: number;
  size: number;
  opacity: number;
  duration: number;
  delay: number;
}

const HAND_TUNED_NOTE_MOTES: NoteMoteConfig[] = [
  { left: 6, bottom: -14, size: 10, opacity: 0.22, duration: 9, delay: 0 },
  { left: 20, bottom: -30, size: 8, opacity: 0.16, duration: 7.4, delay: 1.6 },
  { left: 35, bottom: -6, size: 13, opacity: 0.26, duration: 10.8, delay: 3.1 },
  { left: 50, bottom: -22, size: 9, opacity: 0.18, duration: 8.1, delay: 0.5 },
  { left: 66, bottom: -12, size: 12, opacity: 0.2, duration: 11.2, delay: 4.4 },
  { left: 80, bottom: -28, size: 8, opacity: 0.15, duration: 7.9, delay: 2.3 },
  { left: 92, bottom: -8, size: 11, opacity: 0.24, duration: 9.6, delay: 5.2 },
];

function NoteGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={BAND_TEAL} aria-hidden="true">
      <ellipse cx="8.5" cy="17.5" rx="4" ry="3" transform="rotate(-18 8.5 17.5)" />
      <rect x="11.7" y="3" width="1.7" height="15" />
    </svg>
  );
}

function NoteMotes() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
      {HAND_TUNED_NOTE_MOTES.map((mote, i) => (
        <span
          key={i}
          className="note-mote absolute"
          style={{
            left: `${mote.left}%`,
            bottom: `${mote.bottom}%`,
            opacity: mote.opacity,
            animationDuration: `${mote.duration}s`,
            animationDelay: `${mote.delay}s`,
          }}
        >
          <NoteGlyph size={mote.size} />
        </span>
      ))}
    </div>
  );
}

function ClefMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="relative z-10 size-[26px] shrink-0"
      fill="none"
      stroke={BAND_TEAL}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ filter: 'drop-shadow(0 0 4px rgb(46 211 196 / 0.5))' }}
      aria-hidden="true"
    >
      {/* Lucide "clef-treble" (ISC) */}
      <path
        className="clef-draw"
        pathLength={100}
        d="M10.586 21.414a2 2 0 0 0 3.378-1.791L11.036 4.377a2 2 0 1 1 3.378 1.037C12.414 7.414 7 8 7 13a5 5 0 0 0 5 5a5 4 0 0 0 5-4a3 3 0 0 0-3-3a3 2 0 0 0-3 2"
      />
    </svg>
  );
}

function UpdateControl({ update, pending, onArm, onCheckForUpdates }: Pick<AboutOverlayProps, 'update' | 'pending' | 'onArm' | 'onCheckForUpdates'>) {
  if (update === null) return null;

  if (update.armedVersion !== null) {
    return (
      <span className="inline-flex items-center gap-2 text-small text-muted">
        <span className="size-1.5 rounded-full bg-accent" />
        {isIdle(update) ? `Updating to ${update.armedVersion}…` : `${update.armedVersion} restarts when idle`}
      </span>
    );
  }

  if (update.availableVersion !== null) {
    return (
      <button type="button" className={`${btnPrimary} gap-1.5 px-3 py-1.5`} disabled={pending} onClick={onArm}>
        <Icon name="download" className="size-3.5" />
        Update to {update.availableVersion}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center gap-1.5 text-small font-medium text-muted transition-colors duration-150 hover:text-accent disabled:opacity-50 disabled:hover:text-muted"
      disabled={pending}
      onClick={onCheckForUpdates}
    >
      <Icon name="refresh" className={`size-3.5 ${pending ? 'motion-safe:animate-spin' : ''}`} />
      {pending ? 'Checking for updates…' : 'Check for updates'}
    </button>
  );
}

export function AboutOverlay({ appName, currentVersion, update, pending, onArm, onCheckForUpdates, onClose }: AboutOverlayProps) {
  const updateFlagged = update !== null && (update.availableVersion !== null || update.armedVersion !== null);

  return (
    <Modal label="About" onClose={onClose} className="max-w-md overflow-hidden" closeClassName="text-white/60 hover:text-white">
      <div
        className="relative flex items-center gap-2.5 overflow-hidden px-5 py-5"
        style={{
          background: 'linear-gradient(180deg, rgb(255 255 255 / 0.04), rgb(0 0 0 / 0.12)), #17181B',
          borderBottom: '1px solid rgb(46 211 196 / 0.22)',
        }}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(70% 160% at 14% 50%, rgb(46 211 196 / 0.16), transparent 60%)' }}
        />
        <NoteMotes />
        <ClefMark />
        <h2 className="relative z-10 font-display text-display font-display-weight text-white">{appName}</h2>
        <span className="absolute bottom-3 right-4 z-10 inline-flex items-center gap-1.5 font-code text-[11px] text-white/55">
          {updateFlagged && <span className="size-1.5 rounded-full bg-accent" />}
          {currentVersion !== null ? `v${currentVersion}` : 'Checking…'}
        </span>
      </div>

      <div className="px-5 pb-1 pt-4">
        <p className="mb-4 text-small text-muted">Simple agent orchestration.</p>
        <ul className="overflow-hidden rounded-md bg-sunken ring-1 ring-hairline">
          {LINKS.map(({ href, icon, label, hint }, i) => (
            <li key={href} className={i > 0 ? 'border-t border-hairline' : ''}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex min-h-11 items-center gap-3 px-3 py-2 transition-colors duration-150 hover:bg-raised focus-visible:relative focus-visible:z-10 focus-visible:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded bg-accent-tint text-accent">
                  <Icon name={icon} className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-medium text-ink transition-colors duration-150 group-hover:text-accent">{label}</span>
                  <span className="truncate text-small text-faint">{hint}</span>
                </span>
                <Icon
                  name="arrow-up-right"
                  className="ml-auto size-4 shrink-0 text-faint transition-all duration-150 group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-accent"
                />
              </a>
            </li>
          ))}
        </ul>
      </div>

      <div className="mx-5 flex items-center gap-3 border-t border-hairline py-3">
        <UpdateControl update={update} pending={pending} onArm={onArm} onCheckForUpdates={onCheckForUpdates} />
        <button
          type="button"
          className="ml-auto inline-flex min-h-11 items-center font-medium text-muted transition-colors duration-150 hover:text-ink"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
