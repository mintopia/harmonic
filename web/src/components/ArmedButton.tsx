import { useArmedConfirm } from './useArmedConfirm';

/**
 * A destructive action guarded by the shared two-step armed confirm
 * (useArmedConfirm, DESIGN.md bans native confirm()): the first click arms and
 * swaps to `armedLabel` in fail-red, a second within the window commits; a
 * click-away or timeout reverts. The same guard the Board/detail task Cancel
 * and the Activity Stop use, packaged for reuse — the Conversation delete
 * (issue #98) so it is never a single bare click.
 */
export function ArmedButton({
  label,
  armedLabel,
  className,
  onConfirm,
  ariaLabel,
}: {
  label: string;
  armedLabel: string;
  /** Resting class string; the armed state renders its own fail-red weight. */
  className: string;
  onConfirm: () => void;
  ariaLabel?: string;
}) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? armedLabel : label}
    </button>
  );
}
