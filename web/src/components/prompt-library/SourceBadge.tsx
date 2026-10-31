export function SourceBadge({ bundled }: { bundled: boolean }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-label font-semibold uppercase ${
        bundled ? 'bg-raised text-muted' : 'bg-accent-tint text-accent'
      }`}
    >
      {bundled ? 'Bundled' : 'Yours'}
    </span>
  );
}
