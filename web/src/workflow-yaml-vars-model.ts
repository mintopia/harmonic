import { isMap, parseDocument, type Document } from 'yaml';

export type VarType = 'string' | 'number' | 'boolean';
export interface DeclaredVar {
  name: string;
  type: VarType;
  value: string;
}

function coerce(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return value;
}

function edit(text: string, change: (doc: Document) => void): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return text;
  change(doc);
  return doc.toString({ lineWidth: 0 });
}

export function readVars(text: string): DeclaredVar[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return [];
  const vars = doc.get('vars', true);
  if (!isMap(vars)) return [];
  return vars.items.map((pair) => {
    const raw = (pair.value as { value?: unknown } | null)?.value;
    const type: VarType = typeof raw === 'number' ? 'number' : typeof raw === 'boolean' ? 'boolean' : 'string';
    return { name: String((pair.key as { value?: unknown }).value), type, value: String(raw ?? '') };
  });
}

export function readRunsOn(text: string): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  const value = doc.get('runs_on');
  return typeof value === 'string' ? value : null;
}

export function setVar(text: string, name: string, value: string): string {
  return edit(text, (doc) => {
    if (doc.hasIn(['vars', name])) doc.setIn(['vars', name], coerce(value));
  });
}

export function addVar(text: string, name: string, value: string): string {
  return edit(text, (doc) => {
    if (doc.hasIn(['vars', name])) return;
    doc.setIn(['vars', name], coerce(value));
  });
}

export function removeVar(text: string, name: string): string {
  return edit(text, (doc) => {
    doc.deleteIn(['vars', name]);
    const vars = doc.get('vars', true);
    if (isMap(vars) && vars.items.length === 0) doc.delete('vars');
  });
}

export function overriddenIn(
  workflow: string,
  varName: string,
  workspaces: readonly { name: string; workflowVars?: Record<string, Record<string, unknown>> | null }[],
): string[] {
  return workspaces.filter((w) => w.workflowVars?.[workflow]?.[varName] !== undefined).map((w) => w.name);
}
