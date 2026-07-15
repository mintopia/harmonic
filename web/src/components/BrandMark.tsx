/** The Harmonic mark: an accent-filled rounded square carrying a four-bar
 * glyph — a waveform (harmonic) that also reads as parallel run lanes (the
 * board). The one place the product's identity is drawn; shared by the
 * sidebar and Login so the brand never drifts between surfaces. Static by
 * design — no motion to compete with live state (DESIGN.md § Navigation). */
export function BrandMark() {
  return (
    <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-md bg-accent text-on-accent">
      <svg viewBox="0 0 20 20" className="size-5" fill="currentColor" aria-hidden="true">
        {/* Bars centred on y=10; heights step up then settle, like a standing wave. */}
        <rect x="3" y="7.5" width="2" height="5" rx="1" />
        <rect x="7" y="3.5" width="2" height="13" rx="1" />
        <rect x="11" y="6" width="2" height="8" rx="1" />
        <rect x="15" y="4.5" width="2" height="11" rx="1" />
      </svg>
    </span>
  );
}
