import type { ReactNode } from 'react';

export function Fact({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="mb-[3px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}
