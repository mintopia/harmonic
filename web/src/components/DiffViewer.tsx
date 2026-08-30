import type { DiffFile, DiffLine } from '../types';

function rowClass(kind: DiffLine['kind']): string {
  if (kind === 'add') return 'bg-merged-tint';
  if (kind === 'del') return 'bg-fail-tint';
  if (kind === 'hunk') return 'bg-raised';
  return '';
}

function sign(kind: DiffLine['kind']): { char: string; cls: string } {
  if (kind === 'add') return { char: '+', cls: 'text-merged' };
  if (kind === 'del') return { char: '-', cls: 'text-fail' };
  return { char: ' ', cls: 'text-faint' };
}

/** `headerless` drops the path/±count strip — the single-file diff panel
 * already carries the filename as its content title and the ± summary above the
 * hunks, so the strip would repeat it. */
export function DiffViewer({ file, headerless = false }: { file: DiffFile; headerless?: boolean }) {
  return (
    <div className="overflow-x-auto bg-surface">
      {!headerless && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-hairline">
          <span className="font-data text-[12.5px] text-ink truncate">{file.path}</span>
          <span className="font-data text-[11.5px] ml-auto flex gap-2 tabular-nums">
            <span className="text-merged">+{file.additions}</span>
            <span className="text-fail">−{file.deletions}</span>
          </span>
        </div>
      )}
      {file.lines.length === 0 ? (
        <div className="px-4 py-3 text-faint text-sm">No diff available for this file.</div>
      ) : (
        <table className="w-full border-collapse font-data text-[12.5px] leading-relaxed">
          <tbody>
            {file.lines.map((line, i) => {
              if (line.kind === 'hunk') {
                return (
                  <tr key={i} className="bg-raised">
                    <td className="w-11 bg-raised" />
                    <td className="px-3 py-0.5 whitespace-pre text-muted">{line.text}</td>
                  </tr>
                );
              }
              const s = sign(line.kind);
              return (
                <tr key={i} className={rowClass(line.kind)}>
                  <td className="w-11 text-right pr-2.5 align-top text-[11.5px] text-faint tabular-nums select-none whitespace-nowrap">
                    {line.newLn ?? line.oldLn ?? ''}
                  </td>
                  <td className="pl-3 pr-3.5 whitespace-pre text-ink">
                    <span className={`inline-block w-3 ${s.cls}`}>{s.char}</span>
                    {line.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
