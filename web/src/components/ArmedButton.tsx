import { useArmedConfirm } from './useArmedConfirm';

export function ArmedButton({
  label,
  armedLabel,
  className,
  onConfirm,
  ariaLabel,
}: {
  label: string;
  armedLabel: string;
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
