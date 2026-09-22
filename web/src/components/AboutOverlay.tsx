import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Icon, type IconName } from './Icon';
import { btnPrimary } from '../ui';
import type { UpdateState } from '../types';

const DOCS_URL = 'https://mintopia.github.io/harmonic';
const REPO_URL = 'https://github.com/mintopia/harmonic';
const AUTHOR_URL = 'https://github.com/mintopia';
const SITE_URL = 'https://mintopia.net';

const PRODUCT_NAME = 'Harmonic';

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
  currentVersion: string | null;
  update: UpdateState | null;
  pending: boolean;
  onArm: () => void;
  onCheckForUpdates: () => void;
  onClose: () => void;
}

type MoteVariant = 'quarter' | 'eighth' | 'beamed' | 'sixteenth' | 'half';

interface NoteMoteConfig {
  left: number;
  bottom: number;
  size: number;
  opacity: number;
  duration: number;
  delay: number;
  rotate: number;
  variant: MoteVariant;
}

const NOTE_MOTES: NoteMoteConfig[] = [
  { left: 8, bottom: -12, size: 12, opacity: 0.26, duration: 9.5, delay: 0, rotate: -8, variant: 'eighth' },
  { left: 19, bottom: -30, size: 9, opacity: 0.16, duration: 7.6, delay: 1.7, rotate: 10, variant: 'quarter' },
  { left: 31, bottom: -6, size: 15, opacity: 0.24, duration: 11.2, delay: 3.0, rotate: -4, variant: 'beamed' },
  { left: 45, bottom: -22, size: 10, opacity: 0.19, duration: 8.3, delay: 0.6, rotate: 14, variant: 'sixteenth' },
  { left: 58, bottom: -12, size: 13, opacity: 0.22, duration: 10.6, delay: 4.2, rotate: -12, variant: 'quarter' },
  { left: 70, bottom: -28, size: 9, opacity: 0.15, duration: 7.9, delay: 2.4, rotate: 8, variant: 'half' },
  { left: 82, bottom: -8, size: 12, opacity: 0.25, duration: 9.9, delay: 5.1, rotate: -6, variant: 'eighth' },
  { left: 92, bottom: -20, size: 10, opacity: 0.18, duration: 8.7, delay: 1.1, rotate: 12, variant: 'quarter' },
];

const MOTE_ASPECT: Record<MoteVariant, number> = { quarter: 1, eighth: 1, sixteenth: 1, half: 1, beamed: 28 / 24 };

function MoteGlyph({ variant, size }: { variant: MoteVariant; size: number }) {
  const w = size * MOTE_ASPECT[variant];
  const common = { height: size, width: w, fill: BAND_TEAL, 'aria-hidden': true } as const;

  switch (variant) {
    case 'quarter':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <ellipse cx="8.5" cy="17.5" rx="4" ry="3" transform="rotate(-18 8.5 17.5)" />
          <rect x="11.7" y="3" width="1.7" height="15" />
        </svg>
      );
    case 'eighth':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <ellipse cx="8.5" cy="17.5" rx="4" ry="3" transform="rotate(-18 8.5 17.5)" />
          <rect x="11.7" y="3" width="1.7" height="15" />
          <path d="M13.4 3c5.6 1.6 6 6.2 2.6 9.9 1.4-3.9-.2-6.6-2.6-7.8Z" />
        </svg>
      );
    case 'sixteenth':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <ellipse cx="8.5" cy="17.5" rx="4" ry="3" transform="rotate(-18 8.5 17.5)" />
          <rect x="11.7" y="3" width="1.7" height="15" />
          <path d="M13.4 3c5.6 1.6 6 6.2 2.6 9.9 1.4-3.9-.2-6.6-2.6-7.8Z" />
          <path d="M13.4 7.6c5.6 1.6 6 6.2 2.6 9.9 1.4-3.9-.2-6.6-2.6-7.8Z" />
        </svg>
      );
    case 'half':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <ellipse
            cx="8.5"
            cy="17.5"
            rx="4"
            ry="3"
            transform="rotate(-18 8.5 17.5)"
            fill="none"
            stroke={BAND_TEAL}
            strokeWidth="1.6"
          />
          <rect x="11.7" y="3" width="1.7" height="15" />
        </svg>
      );
    case 'beamed':
      return (
        <svg viewBox="0 0 28 24" {...common}>
          <ellipse cx="6" cy="17.5" rx="4" ry="3" transform="rotate(-18 6 17.5)" />
          <ellipse cx="18" cy="17.5" rx="4" ry="3" transform="rotate(-18 18 17.5)" />
          <rect x="9.2" y="4" width="1.7" height="13.5" />
          <rect x="21.2" y="4" width="1.7" height="13.5" />
          <rect x="9.2" y="3.4" width="13.7" height="3" transform="rotate(-6 9.2 3.4)" />
        </svg>
      );
  }
}

function NoteMotes() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
      {NOTE_MOTES.map((mote, i) => (
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
          <span
            className="mote-sway block"
            style={
              {
                '--sway-dur': `${(mote.duration * 0.55).toFixed(1)}s`,
                '--sway-delay': `${mote.delay}s`,
              } as React.CSSProperties
            }
          >
            <span className="block" style={{ transform: `rotate(${mote.rotate}deg)` }}>
              <MoteGlyph variant={mote.variant} size={mote.size} />
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}

const VB_W = 460;
const VB_H = 96;
const STAFF_GAP = 6;
const TOP_LINE_Y = 36;
const MIDDLE_Y = TOP_LINE_Y + 2 * STAFF_GAP;
const E4_Y = TOP_LINE_Y + 4 * STAFF_GAP;
const MIDDLE_STEP = 4; // B4 on the middle line: notes at/above it stem down
const CLEF_ZONE = 72;
const BARLINE_TO_NOTE_GAP = 5;
const PX_PER_BEAT = 28;
const START_X = 380;
const LEAD_GAP = Math.max(320, START_X - CLEF_ZONE);
const HEAD_RX = 3.6;
const HEAD_RY = 2.7;
const STEM_LEN = 21;

// Staff step: diatonic distance above the bottom line E4 (E4=0, one step = half a gap).
const LETTER_STEP: Record<string, number> = { C: -2, D: -1, E: 0, F: 1, G: 2, A: 3, B: 4 };

type RawNote = [pitch: string, beats: number];
interface Melody {
  title: string;
  timeSig: [number, number];
  tempoBpm: number;
  notes: RawNote[];
}

const ODE_TO_JOY: Melody = {
  title: 'Ode to Joy',
  timeSig: [4, 4],
  tempoBpm: 112,
  notes: [
    ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1],
    ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
    ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
    ['E4', 1.5], ['D4', 0.5], ['D4', 2],
  ],
};

const TETRIS: Melody = {
  title: 'Tetris (Korobeiniki)',
  timeSig: [4, 4],
  tempoBpm: 150,
  notes: [
    ['E5', 1], ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['C5', 0.5], ['B4', 0.5],
    ['A4', 1], ['A4', 0.5], ['C5', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 0.5],
    ['B4', 1.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ['C5', 1], ['A4', 1], ['A4', 2],
  ],
};

const DIES_IRAE: Melody = {
  title: 'Dies Irae',
  timeSig: [4, 4],
  tempoBpm: 92,
  notes: [
    ['F4', 1], ['E4', 1], ['F4', 1], ['D4', 1],
    ['E4', 1], ['C4', 1], ['D4', 2],
    ['D4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
    ['F4', 1], ['E4', 1], ['D4', 2],
  ],
};

const TOCCATA: Melody = {
  title: 'Toccata and Fugue in D minor',
  timeSig: [4, 4],
  tempoBpm: 76,
  notes: [
    ['A4', 0.5], ['G4', 0.5], ['A4', 3],
    ['A4', 0.5], ['G4', 0.5], ['F4', 0.5], ['E4', 0.5], ['D4', 0.5], ['C#4', 0.5], ['D4', 1],
  ],
};

const MELODIES: Melody[] = [ODE_TO_JOY, TETRIS, DIES_IRAE, TOCCATA];

function pitchStep(pitch: string): number {
  return LETTER_STEP[pitch[0]!]! + (Number(pitch[pitch.length - 1]) - 4) * 7;
}
function pitchAccidental(pitch: string): '' | '#' | 'b' {
  return pitch[1] === '#' || pitch[1] === 'b' ? (pitch[1] as '#' | 'b') : '';
}
function noteY(step: number): number {
  return E4_Y - step * (STAFF_GAP / 2);
}
function ledgerSteps(step: number): number[] {
  const out: number[] = [];
  if (step < 0) for (let e = -2; e >= step; e -= 2) out.push(e);
  else if (step > 8) for (let e = 10; e <= step; e += 2) out.push(e);
  return out;
}
function noteShape(beats: number): { hollow: boolean; flags: number; dot: boolean; stemmed: boolean } {
  const dot = beats === 3 || beats === 1.5 || beats === 0.75 || beats === 0.375;
  const base = dot ? beats / 1.5 : beats;
  return { hollow: base >= 2, flags: base === 0.5 ? 1 : base === 0.25 ? 2 : 0, dot, stemmed: base < 4 };
}

interface LaidNote {
  pitch: string;
  beats: number;
  startBeat: number;
  step: number;
  y: number;
  acc: '' | '#' | 'b';
  shape: ReturnType<typeof noteShape>;
  groupId: number;
  stemDir: 'up' | 'down';
  tieToNext: boolean;
}

interface StavePlan {
  laid: LaidNote[];
  groups: number[][];
  totalBeats: number;
  barBeats: number;
  period: number;
  durS: number;
  timeSig: [number, number];
}

function planMelody(melody: Melody): StavePlan {
  const barBeats = (melody.timeSig[0] * 4) / melody.timeSig[1];
  const laid: LaidNote[] = [];
  let beat = 0;
  for (const [pitch, beats] of melody.notes) {
    const rest = pitch === 'r';
    const step = rest ? 0 : pitchStep(pitch);
    const acc = rest ? '' : pitchAccidental(pitch);
    const stemDir: 'up' | 'down' = step >= MIDDLE_STEP ? 'down' : 'up';
    const end = beat + beats;
    for (let segStart = beat; segStart < end - 1e-9; ) {
      const nextBar = (Math.floor(segStart / barBeats + 1e-9) + 1) * barBeats;
      const segEnd = Math.min(end, nextBar);
      laid.push({
        pitch, beats: segEnd - segStart, startBeat: segStart, step, y: noteY(step),
        acc, shape: noteShape(segEnd - segStart), groupId: -1, stemDir, tieToNext: !rest && segEnd < end - 1e-9,
      });
      segStart = segEnd;
    }
    beat = end;
  }

  // Beam consecutive eighths/sixteenths that share a quarter-note beat unit; the
  // whole group shares one stem direction (chosen by the note farthest from centre).
  const beamable = (l: LaidNote) => l.pitch !== 'r' && l.shape.flags >= 1 && l.shape.stemmed;
  const groups: number[][] = [];
  for (let i = 0; i < laid.length; ) {
    if (!beamable(laid[i]!)) { i++; continue; }
    const unit = Math.floor(laid[i]!.startBeat);
    let j = i;
    while (j < laid.length && beamable(laid[j]!) && Math.floor(laid[j]!.startBeat) === unit) j++;
    if (j - i >= 2) groups.push(Array.from({ length: j - i }, (_, k) => i + k));
    i = j;
  }
  groups.forEach((g, gi) => {
    let far = g[0]!;
    for (const k of g) if (Math.abs(laid[k]!.step - MIDDLE_STEP) > Math.abs(laid[far]!.step - MIDDLE_STEP)) far = k;
    const dir: 'up' | 'down' = laid[far]!.step - MIDDLE_STEP > 0 ? 'down' : 'up';
    for (const k of g) { laid[k]!.groupId = gi; laid[k]!.stemDir = dir; }
  });

  const period = beat * PX_PER_BEAT + LEAD_GAP;
  const durS = (period * 60) / (PX_PER_BEAT * melody.tempoBpm);
  return { laid, groups, totalBeats: beat, barBeats, period, durS, timeSig: melody.timeSig };
}

function Accidental({ kind, x, y }: { kind: '#' | 'b'; x: number; y: number }) {
  if (kind === '#') {
    return (
      <g stroke={BAND_TEAL} strokeWidth={0.75}>
        <line x1={x - 1.2} y1={y - 3} x2={x - 1.2} y2={y + 3.4} />
        <line x1={x + 1.2} y1={y - 3.4} x2={x + 1.2} y2={y + 3} />
        <line x1={x - 2.2} y1={y - 0.9} x2={x + 2.2} y2={y - 1.6} />
        <line x1={x - 2.2} y1={y + 1.6} x2={x + 2.2} y2={y + 0.9} />
      </g>
    );
  }
  return (
    <g stroke={BAND_TEAL} strokeWidth={0.75} fill="none">
      <line x1={x - 1.4} y1={y - 5.2} x2={x - 1.4} y2={y + 2.4} />
      <path d={`M${x - 1.4} ${y - 1.4}c2.4 -1.5 3.8 0.7 0 3`} />
    </g>
  );
}

function Flag({ up, count, x, y }: { up: boolean; count: number; x: number; y: number }) {
  const d = up ? 1 : -1;
  return (
    <g fill={BAND_TEAL}>
      {Array.from({ length: count }, (_, i) => (
        <path key={i} d={`M${x} ${y + i * 4.5 * d}c4.6 ${1.4 * d} 4.9 ${5 * d} 2.1 ${8.2 * d}c1.2 ${-3.2 * d} -0.1 ${-5.4 * d} -2.1 ${-6.4 * d}Z`} />
      ))}
    </g>
  );
}

function Rest({ beats, x }: { beats: number; x: number }) {
  const base = beats === 3 || beats === 1.5 ? beats / 1.5 : beats;
  if (base >= 2) {
    return <rect x={x - 3} y={base >= 4 ? MIDDLE_Y - STAFF_GAP : MIDDLE_Y - 2.2} width={6} height={2.2} fill={BAND_TEAL} />;
  }
  if (base === 0.5) {
    return (
      <g fill={BAND_TEAL}>
        <line x1={x + 1.6} y1={MIDDLE_Y - 4.5} x2={x - 1} y2={MIDDLE_Y + 3.5} stroke={BAND_TEAL} strokeWidth={0.9} />
        <circle cx={x - 1.2} cy={MIDDLE_Y - 3.4} r={1.2} />
      </g>
    );
  }
  return (
    <path
      d={`M${x - 1.4} ${MIDDLE_Y - 6}c1.9 1.7 -0.6 2.9 0.8 4.6c1.5 1.7 -1.9 2.6 -0.4 4.8c-2 -1.5 -0.3 -3.6 -1.3 -4.6c1.4 0.6 2.2 -0.6 1.1 -2c-0.9 -1.1 -0.4 -2 0.1 -2.8Z`}
      fill={BAND_TEAL}
    />
  );
}

function StaveMelody({ plan, offsetX }: { plan: StavePlan; offsetX: number }) {
  const { laid, groups, totalBeats, barBeats } = plan;
  const headX = (startBeat: number) => START_X + offsetX + startBeat * PX_PER_BEAT + BARLINE_TO_NOTE_GAP;
  const stemXOf = (l: LaidNote) => headX(l.startBeat) + (l.stemDir === 'up' ? HEAD_RX * 0.85 : -HEAD_RX * 0.85);
  const stemEndOf = (l: LaidNote) => l.y + (l.stemDir === 'up' ? -STEM_LEN : STEM_LEN);

  const bars = [];
  for (let b = barBeats; b <= totalBeats + 0.001; b += barBeats) {
    const x = START_X + offsetX + b * PX_PER_BEAT;
    bars.push(<line key={`bar${b}`} x1={x} y1={TOP_LINE_Y} x2={x} y2={E4_Y} stroke={BAND_TEAL} strokeWidth={0.9} opacity={0.55} />);
  }

  const glyphs = laid.map((l, i) => {
    const x = headX(l.startBeat);
    if (l.pitch === 'r') return <Rest key={i} beats={l.beats} x={x} />;
    const { y, acc, shape, stemDir, groupId } = l;
    const up = stemDir === 'up';
    const stemX = stemXOf(l);
    const stemEnd = stemEndOf(l);
    return (
      <g key={i}>
        {ledgerSteps(l.step).map((e) => (
          <line key={e} x1={x - HEAD_RX - 2.5} y1={noteY(e)} x2={x + HEAD_RX + 2.5} y2={noteY(e)} stroke={BAND_TEAL} strokeWidth={1} />
        ))}
        {acc && <Accidental kind={acc} x={x - HEAD_RX - 3.5} y={y} />}
        <ellipse cx={x} cy={y} rx={HEAD_RX} ry={HEAD_RY} transform={`rotate(-20 ${x} ${y})`} fill={shape.hollow ? 'none' : BAND_TEAL} stroke={shape.hollow ? BAND_TEAL : 'none'} strokeWidth={shape.hollow ? 1.3 : 0} />
        {shape.dot && <circle cx={x + HEAD_RX + 3} cy={l.step % 2 === 0 ? y - STAFF_GAP / 2 : y} r={1.2} fill={BAND_TEAL} />}
        {shape.stemmed && <line x1={stemX} y1={y} x2={stemX} y2={stemEnd} stroke={BAND_TEAL} strokeWidth={1.2} />}
        {groupId < 0 && shape.flags > 0 && <Flag up={up} count={shape.flags} x={stemX} y={y + (up ? -STEM_LEN : STEM_LEN)} />}
      </g>
    );
  });

  const beams = groups.map((g, gi) => {
    const first = laid[g[0]!]!;
    const last = laid[g[g.length - 1]!]!;
    const off = first.stemDir === 'up' ? 3 : -3;
    const segs: [number, number, number, number][] = [];
    g.forEach((k, m) => {
      const l = laid[k]!;
      if (l.shape.flags < 2) return;
      const px = stemXOf(l);
      const py = stemEndOf(l) + off;
      const nextL = m < g.length - 1 ? laid[g[m + 1]!]! : null;
      const prevL = m > 0 ? laid[g[m - 1]!]! : null;
      if (nextL && nextL.shape.flags >= 2) segs.push([px, py, stemXOf(nextL), stemEndOf(nextL) + off]);
      else if (!(prevL && prevL.shape.flags >= 2)) {
        const toward = prevL ?? nextL!;
        const dx = Math.sign(stemXOf(toward) - px) || 1;
        segs.push([px, py, px + dx * 5, py]);
      }
    });
    return (
      <g key={`beam${gi}`}>
        <line x1={stemXOf(first)} y1={stemEndOf(first)} x2={stemXOf(last)} y2={stemEndOf(last)} stroke={BAND_TEAL} strokeWidth={2.2} />
        {segs.map(([x1, y1, x2, y2], si) => (
          <line key={si} x1={x1} y1={y1} x2={x2} y2={y2} stroke={BAND_TEAL} strokeWidth={1.7} />
        ))}
      </g>
    );
  });

  const ties = laid.map((l, i) => {
    if (!l.tieToNext) return null;
    const next = laid[i + 1]!;
    const x1 = headX(l.startBeat) + HEAD_RX;
    const x2 = headX(next.startBeat) - HEAD_RX;
    const o = l.stemDir === 'up' ? HEAD_RY + 1.6 : -(HEAD_RY + 1.6);
    const bow = l.stemDir === 'up' ? 3 : -3;
    return <path key={`tie${i}`} d={`M${x1} ${l.y + o} Q${(x1 + x2) / 2} ${l.y + o + bow} ${x2} ${l.y + o}`} stroke={BAND_TEAL} strokeWidth={1} fill="none" />;
  });

  return (
    <g>
      {bars}
      {beams}
      {glyphs}
      {ties}
    </g>
  );
}

function StaveBackdrop({ plan }: { plan: StavePlan }) {
  const lineYs = [0, 1, 2, 3, 4].map((i) => TOP_LINE_Y + i * STAFF_GAP);
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMinYMid slice" className="size-full">
        <defs>
          <linearGradient id="lines-fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" />
            <stop offset="0.76" stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
          <linearGradient id="notes-fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#000" />
            <stop offset={CLEF_ZONE / VB_W} stopColor="#000" />
            <stop offset={(CLEF_ZONE + 26) / VB_W} stopColor="#fff" />
            <stop offset="0.76" stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
          <mask id="lines-mask">
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="url(#lines-fade)" />
          </mask>
          <mask id="notes-mask">
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="url(#notes-fade)" />
          </mask>
        </defs>

        <g mask="url(#lines-mask)" stroke={BAND_TEAL} strokeWidth={0.9} opacity={0.24}>
          {lineYs.map((y) => (
            <line key={y} x1={0} y1={y} x2={VB_W} y2={y} />
          ))}
        </g>

        <g mask="url(#notes-mask)" opacity={0.4}>
          <g
            className="stave-scroll"
            style={
              {
                '--loop-w': `${plan.period}px`,
                '--loop-dur': `${plan.durS}s`,
                '--static-x': `${START_X - CLEF_ZONE}px`,
              } as React.CSSProperties
            }
          >
            <StaveMelody plan={plan} offsetX={0} />
            <StaveMelody plan={plan} offsetX={plan.period} />
          </g>
        </g>

        <g fill={BAND_TEAL} opacity={0.4} fontWeight={600}>
          <text x={58} y={TOP_LINE_Y + STAFF_GAP + 1.5} textAnchor="middle" fontSize={11}>
            {plan.timeSig[0]}
          </text>
          <text x={58} y={E4_Y - STAFF_GAP + 1.5} textAnchor="middle" fontSize={11}>
            {plan.timeSig[1]}
          </text>
        </g>
      </svg>
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

function HeaderBackdrop({ revealStave, plan, introKey }: { revealStave: boolean; plan: StavePlan; introKey: number }) {
  return (
    <>
      <div className="absolute inset-0 z-0 transition-opacity duration-700" style={{ opacity: revealStave ? 0 : 1 }}>
        <NoteMotes />
      </div>
      <div className="absolute inset-0 z-0 transition-opacity duration-700" style={{ opacity: revealStave ? 1 : 0 }}>
        <StaveBackdrop key={introKey} plan={plan} />
      </div>
    </>
  );
}

function UpdateControl({ update, pending, onArm, onCheckForUpdates }: Pick<AboutOverlayProps, 'update' | 'pending' | 'onArm' | 'onCheckForUpdates'>) {
  if (update === null) return null;

  if (update.upgradingVersion !== null) {
    return (
      <span className="inline-flex items-center gap-2 text-small text-muted">
        <span className="size-1.5 rounded-full bg-accent" />
        Updating to {update.upgradingVersion}…
      </span>
    );
  }

  if (update.armedVersion !== null) {
    return (
      <span className="inline-flex items-center gap-2 text-small text-muted">
        <span className="size-1.5 rounded-full bg-accent" />
        {update.armedVersion} restarts when idle
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

export function AboutOverlay({ currentVersion, update, pending, onArm, onCheckForUpdates, onClose }: AboutOverlayProps) {
  const updateFlagged = update !== null && (update.availableVersion !== null || update.armedVersion !== null);
  const [staveRevealed, setStaveRevealed] = useState(false);
  const [introKey, setIntroKey] = useState(0);
  // Random tune per open; picked in an effect (before any hover) to keep render pure.
  const [melodyIndex, setMelodyIndex] = useState(0);
  useEffect(() => setMelodyIndex(Math.floor(Math.random() * MELODIES.length)), []);
  const plan = useMemo(() => planMelody(MELODIES[melodyIndex]!), [melodyIndex]);

  return (
    <Modal label="About" onClose={onClose} className="max-w-md overflow-hidden" closeClassName="text-white/60 hover:text-white">
      <div
        className="relative flex items-center gap-2.5 overflow-hidden px-5 py-5"
        style={{
          background: 'linear-gradient(180deg, rgb(255 255 255 / 0.04), rgb(0 0 0 / 0.12)), #17181B',
          borderBottom: '1px solid rgb(46 211 196 / 0.22)',
        }}
        onMouseEnter={() => {
          setStaveRevealed(true);
          setIntroKey((k) => k + 1);
        }}
        onMouseLeave={() => setStaveRevealed(false)}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(70% 160% at 14% 50%, rgb(46 211 196 / 0.16), transparent 60%)' }}
        />
        <HeaderBackdrop revealStave={staveRevealed} plan={plan} introKey={introKey} />
        <ClefMark />
        <h2
          className="relative z-10 font-display text-display font-display-weight text-white"
          style={{ textShadow: '0 0 10px rgb(46 211 196 / 0.5), 0 0 26px rgb(46 211 196 / 0.28)' }}
        >
          {PRODUCT_NAME}
        </h2>
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
