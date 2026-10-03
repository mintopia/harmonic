import type { JSX } from 'react';

const GLYPHS: Record<string, JSX.Element> = {
  claude: <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />,
  codex: (
    <>
      <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" />
      <path d="M6 6.5l2 1.5-2 1.5M8.8 9.6h1.6" />
    </>
  ),
  copilot: (
    <>
      <rect x="2" y="5" width="12" height="7" rx="3" />
      <path d="M5.5 8v1.4M10.5 8v1.4M6 5V3.5M10 5V3.5" />
    </>
  ),
};

const FALLBACK = <rect x="3" y="3" width="10" height="10" rx="2" />;

export function HarnessGlyph({ harness, className = 'size-[15px]' }: { harness: string | null; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`${className} flex-none fill-none stroke-current`}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {(harness && GLYPHS[harness.toLowerCase()]) || FALLBACK}
    </svg>
  );
}
