import { createElement, type ReactNode } from 'react';
import { toolChip } from '../ui.js';

const MODEL_PREFIXES = ['claude-', 'gpt-', 'copilot-', 'cursor-'] as const;

const PROVIDER_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  cursor: 'Cursor',
} as const;

function el(type: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(type, props, ...children);
}

export function providerLabel(harness: string): string {
  const normalized = harness.trim().toLowerCase();
  return PROVIDER_LABELS[normalized as keyof typeof PROVIDER_LABELS] ?? harness;
}

export function formatModelLabel(model: string): string {
  const normalized = model.toLowerCase();
  for (const prefix of MODEL_PREFIXES) {
    if (normalized.startsWith(prefix)) return model.slice(prefix.length);
  }
  return model;
}

export function ProviderChip({
  harness,
  compact = false,
  className = '',
}: {
  harness: string;
  compact?: boolean;
  className?: string;
}) {
  const label = providerLabel(harness);
  const modeClass = compact ? 'gap-1.5 pr-1.5 sm:pr-2' : 'gap-2';

  return el(
    'span',
    { className: `${toolChip} inline-flex items-center ${modeClass} ${className}`.trim(), title: label },
    label,
  );
}

export function ModelLabel({ model, className = '' }: { model: string; className?: string }) {
  return el(
    'span',
    { 'aria-label': model, className: `min-w-0 truncate ${className}`.trim(), title: model },
    el('span', { className: 'sr-only' }, model),
    el('span', { 'aria-hidden': 'true' }, formatModelLabel(model)),
  );
}

export function TaskIdentity({
  harness,
  model,
  compact = false,
  className = '',
}: {
  harness: string;
  model: string;
  compact?: boolean;
  className?: string;
}) {
  return el(
    'span',
    { className: `flex min-w-0 items-center gap-2 ${className}`.trim() },
    createElement(ProviderChip, { harness, compact }),
    createElement(ModelLabel, { model, className: 'text-muted' }),
  );
}
