import type { TextPart } from '../execution-targets-model';

export function Parts({ parts, codeClass = 'rounded-sm bg-surface px-1.5 font-data text-small' }: { parts: TextPart[]; codeClass?: string }) {
  return (
    <>
      {parts.map((part, i) =>
        part.code ? (
          <code key={i} className={codeClass}>
            {part.text}
          </code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
