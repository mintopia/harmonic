/** The Harmonic mark: a 20px accent-filled rounded square with the "H"
 * monogram (DESIGN.md § Navigation). Shared by the sidebar and Login so
 * the brand never drifts between surfaces. */
export function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-bold text-on-accent"
    >
      H
    </span>
  );
}
