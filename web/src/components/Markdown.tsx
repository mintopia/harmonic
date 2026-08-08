import { useLayoutEffect, useRef, useState } from 'react';
import { renderMarkdown } from '../markdown';

/**
 * Rendered Markdown that collapses to a few lines with a Show more/less toggle.
 * The toggle appears only when the content actually overflows the collapsed
 * height (measured), so short descriptions stay clean. `collapsedClass` sets the
 * clamp; styling of the rendered tags lives in index.css under `.markdown`.
 */
export function Markdown({
  source,
  collapsedClass = 'max-h-20',
}: {
  source: string;
  collapsedClass?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight - el.clientHeight > 2);
  }, [source]);

  return (
    <div>
      <div
        ref={ref}
        className={`markdown text-small text-muted ${expanded ? '' : `${collapsedClass} overflow-hidden`}`}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
      />
      {(overflowing || expanded) && (
        <button
          type="button"
          className="mt-1 text-small font-medium text-accent hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
