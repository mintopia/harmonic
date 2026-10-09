export type KeyScope = 'full' | 'read' | 'attempt';

type ScopeRule = { pattern: RegExp; attempt: boolean } & ({ read: false } | { read: true; readLabel: string });

// First match wins; read-scoped access additionally requires GET.
const RULES: readonly ScopeRule[] = [
  { pattern: /^\/mcp(\/|$)/, attempt: true, read: false },
  { pattern: /^\/api\/tasks\/[^/]+\/(complete|steer|accept|retry|close|extend-guardrail|export(\/download)?)$/, attempt: false, read: false },
  { pattern: /^\/api\/workspaces\/[^/]+\/epics\/[^/]+\/retry$/, attempt: false, read: false },
  { pattern: /^\/api\/workspaces\/[^/]+\/epics(\/[^/]+)?$/, attempt: false, read: true, readLabel: 'Workspaces and their Epics (`/api/workspaces/:id/epics[/:ref]`)' },
  { pattern: /^\/api\/tasks\/[^/]+\/channels(\/|$)/, attempt: false, read: false },
  { pattern: /^\/api\/tasks(\/|$)/, attempt: true, read: true, readLabel: 'tasks' },
  { pattern: /^\/api\/attempts(\/|$)/, attempt: true, read: true, readLabel: 'attempts' },
  { pattern: /^\/api\/ws$/, attempt: false, read: true, readLabel: 'the WebSocket (`/api/ws`, filtered as above)' },
  { pattern: /^\/api\/workspaces$/, attempt: false, read: true, readLabel: 'Workspaces (`/api/workspaces`)' },
  { pattern: /^\/api\/maps(\/|$)/, attempt: false, read: true, readLabel: 'maps' },
  { pattern: /^\/api\/activity$/, attempt: false, read: true, readLabel: 'the instance-wide Activity snapshot (`/api/activity`, filtered to Attempts only for a read key)' },
  { pattern: /^\/api\/operations$/, attempt: false, read: true, readLabel: 'Operations (`/api/operations`)' },
  { pattern: /^\/api\/scheduled-jobs$/, attempt: false, read: true, readLabel: 'Scheduled Jobs (`/api/scheduled-jobs`)' },
  { pattern: /^\/api\/notifications$/, attempt: false, read: true, readLabel: 'Notifications (`/api/notifications`)' },
];

function ruleFor(path: string): ScopeRule | undefined {
  return RULES.find((rule) => rule.pattern.test(path));
}

export function scopedKeyAllowed(path: string): boolean {
  return ruleFor(path)?.attempt ?? false;
}

export function readScopeAllowed(path: string, method: string): boolean {
  return method === 'GET' && (ruleFor(path)?.read ?? false);
}

export function keyScopesFor(path: string, method: string): KeyScope[] {
  const scopes: KeyScope[] = ['full'];
  if (scopedKeyAllowed(path)) scopes.push('attempt');
  if (readScopeAllowed(path, method)) scopes.push('read');
  return scopes;
}

export function describeKeyScopes(path: string, method: string): string {
  const scopes = keyScopesFor(path, method);
  if (scopes.length === 1) return 'Operator only: reachable with a full-scope key or session, not an attempt-scoped Attempt Key or a Read Key.';
  return `Key scopes: ${scopes.join(', ')}.`;
}

export function readScopeLabels(): string[] {
  return RULES.flatMap((rule) => (rule.read ? [rule.readLabel] : []));
}

export function readScopePathList(): string {
  return readScopeLabels().join(', ');
}
