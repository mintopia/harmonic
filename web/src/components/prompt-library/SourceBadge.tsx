export function SourceBadge({ bundled }: { bundled: boolean }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-badge font-semibold uppercase tracking-[.06em] ${
        bundled ? 'bg-raised text-muted' : 'bg-accent-tint text-accent'
      }`}
    >
      {bundled ? 'Bundled' : 'Yours'}
    </span>
  );
}
