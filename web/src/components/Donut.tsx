export interface DonutSegment {
  /** Stable key + accessible category name. */
  key: string;
  /** Legend label; defaults to `key`. */
  label?: string;
  value: number;
  /** CSS colour for the arc + legend dot (e.g. "var(--hm-running-dot)"). */
  color: string;
}

const R = 42;
const R_INNER = 26;
const CX = 50;
const CY = 50;
const TAU = Math.PI * 2;

const polar = (r: number, a: number): [number, number] => [CX + r * Math.cos(a), CY + r * Math.sin(a)];

/** One donut wedge from angle a0→a1 (radians, 0 = 12 o'clock, clockwise). */
function wedge(a0: number, a1: number): string {
  const [x0o, y0o] = polar(R, a0);
  const [x1o, y1o] = polar(R, a1);
  const [x1i, y1i] = polar(R_INNER, a1);
  const [x0i, y0i] = polar(R_INNER, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0o} ${y0o} A${R} ${R} 0 ${large} 1 ${x1o} ${y1o} L${x1i} ${y1i} A${R_INNER} ${R_INNER} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

/**
 * A donut chart for a small categorical split (run states). Segments carry
 * their own colour — for run states that's the state-signal family (the
 * Signal Rule: a coloured segment *is* a state, exactly like the chips it
 * replaces), not the cobalt data series. The hole holds the total. A single
 * category draws a full ring (a lone wedge can't close a circle).
 */
export function Donut({ segments, total, ariaLabel }: { segments: DonutSegment[]; total: number; ariaLabel?: string }) {
  const sum = segments.reduce((a, s) => a + s.value, 0) || 1;
  let angle = -Math.PI / 2; // start at 12 o'clock
  const arcs = segments.map((s) => {
    const sweep = (s.value / sum) * TAU;
    const a0 = angle;
    angle += sweep;
    return { seg: s, a0, a1: angle };
  });

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
      <svg viewBox="0 0 100 100" className="h-40 w-40 shrink-0" role="img" aria-label={ariaLabel}>
        {segments.length === 1 ? (
          <circle cx={CX} cy={CY} r={(R + R_INNER) / 2} fill="none" stroke={segments[0]!.color} strokeWidth={R - R_INNER} />
        ) : (
          arcs.map(({ seg, a0, a1 }) => <path key={seg.key} d={wedge(a0, a1)} fill={seg.color} />)
        )}
        <text x={CX} y={CY - 2} textAnchor="middle" className="fill-ink tabular-nums" fontSize="15" fontWeight="700">
          {total.toLocaleString()}
        </text>
        <text x={CX} y={CY + 9} textAnchor="middle" className="fill-muted" fontSize="6.5" letterSpacing="0.5">
          {total === 1 ? 'RUN' : 'RUNS'}
        </text>
      </svg>
      <ul className="flex min-w-[8rem] flex-col gap-1.5">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-data">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: s.color }} aria-hidden="true" />
            <span className="text-ink">{s.label ?? s.key}</span>
            <span className="ml-auto pl-3 tabular-nums text-muted">
              {s.value.toLocaleString()}
              <span className="ml-1.5 text-faint">{Math.round((s.value / sum) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
