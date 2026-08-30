import { Icon } from '../Icon';

/** The follow/tail control shared by the Timeline header bar and the Attempt
 * transcript: a single toggle that pins the view to the live bottom. Engaged,
 * it shows a pulsing live dot; released, it invites a jump back to the tail. */
export function FollowTail({ following, onToggle }: { following: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={following}
      onClick={onToggle}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
        following
          ? 'border-transparent bg-accent-tint text-accent'
          : 'border-edge text-muted hover:bg-raised hover:text-ink'
      }`}
    >
      {following ? (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-dot-pulse" />
          Following
        </>
      ) : (
        <>
          <Icon name="chevron-down" className="size-3" />
          Follow
        </>
      )}
    </button>
  );
}
