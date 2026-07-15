import type { ReactNode } from 'react';
import { card, labelType } from '../ui';

/**
 * Settings section card (DESIGN.md § Settings): each section is a card
 * floating on the canvas — title, one-line muted description, controls.
 * The parent stacks them at 16px; content caps at 48rem so field rows
 * never sprawl.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={`${card} max-w-3xl p-5`}>
      <h3 className="text-title font-semibold">{title}</h3>
      <p className="mb-4 mt-0.5 text-muted">{description}</p>
      {children}
    </section>
  );
}

/** Uppercase field label above an input. */
export const fieldLabel = `mb-1.5 block ${labelType} text-muted`;

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-label text-fail">{message}</p>;
}
