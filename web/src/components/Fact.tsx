import type { ReactNode } from 'react';

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-[3px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}
