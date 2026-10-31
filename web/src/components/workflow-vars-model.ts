export type VarValue = string | number | boolean;
export type VarSource = 'default' | 'workspace' | 'ticket';
export type VarType = 'number' | 'boolean' | 'string';

export interface TicketVar {
  name: string;
  default: VarValue;
  workspace: VarValue | null;
  ticket: VarValue | null;
  value: VarValue;
  source: VarSource;
}

export interface VarRow {
  name: string;
  type: VarType;
  default: VarValue;
  value: VarValue;
  source: VarSource;
}

export const varType = (value: VarValue): VarType => (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string');

export function workspaceVarRows(defaults: Readonly<Record<string, VarValue>>, overrides: Readonly<Record<string, VarValue>> | null | undefined): VarRow[] {
  return Object.entries(defaults).map(([name, fallback]) => {
    const own = overrides && Object.hasOwn(overrides, name) && typeof overrides[name] === typeof fallback ? overrides[name] : undefined;
    return { name, type: varType(fallback), default: fallback, value: own ?? fallback, source: own === undefined ? 'default' : 'workspace' };
  });
}

export function ticketVarRows(vars: readonly TicketVar[]): VarRow[] {
  return vars.map((entry) => ({ name: entry.name, type: varType(entry.default), default: entry.default, value: entry.value, source: entry.source }));
}

export function defaultHint(entry: Pick<TicketVar, 'default' | 'workspace'>): string {
  return entry.workspace === null ? String(entry.default) : `${String(entry.default)} ← Workspace ${String(entry.workspace)}`;
}

export type ParsedVar = { ok: true; value: VarValue } | { ok: false; message: string };

export function parseVarInput(name: string, fallback: VarValue, text: string): ParsedVar {
  if (typeof fallback === 'string') return { ok: true, value: text };
  const refused: ParsedVar = { ok: false, message: `${name} must be a ${varType(fallback)} (the workflow default is ${String(fallback)}).` };
  if (typeof fallback === 'boolean') return text === 'true' ? { ok: true, value: true } : text === 'false' ? { ok: true, value: false } : refused;
  const trimmed = text.trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed)) ? { ok: true, value: Number(trimmed) } : refused;
}

export function overridesFrom(rows: readonly VarRow[], level: Exclude<VarSource, 'default'>): Record<string, VarValue> {
  return Object.fromEntries(rows.filter((row) => row.source === level).map((row) => [row.name, row.value]));
}

export interface Inherited {
  value: VarValue;
  source: VarSource;
}

export function setRowValue(row: VarRow, value: VarValue, overrideSource: Exclude<VarSource, 'default'>, inherited: Inherited = { value: row.default, source: 'default' }): VarRow {
  return value === inherited.value ? { ...row, value, source: inherited.source } : { ...row, value, source: overrideSource };
}

export function resetRow(row: VarRow, inherited: Inherited = { value: row.default, source: 'default' }): VarRow {
  return { ...row, value: inherited.value, source: inherited.source };
}

export const ticketInherited = (entry: Pick<TicketVar, 'default' | 'workspace'>): Inherited =>
  entry.workspace === null ? { value: entry.default, source: 'default' } : { value: entry.workspace, source: 'workspace' };

export function withWorkflowOverrides(
  all: Readonly<Record<string, Record<string, VarValue>>> | null | undefined,
  workflow: string,
  overrides: Readonly<Record<string, VarValue>>,
): Record<string, Record<string, VarValue>> | null {
  const { [workflow]: _dropped, ...rest } = all ?? {};
  const next = Object.keys(overrides).length === 0 ? rest : { ...rest, [workflow]: { ...overrides } };
  return Object.keys(next).length === 0 ? null : next;
}
