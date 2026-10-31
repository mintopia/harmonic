import { z } from 'zod';

export type VarValue = string | number | boolean;
export type VarRecord = Readonly<Record<string, VarValue>>;
export type VarSource = 'default' | 'workspace' | 'ticket';

export const varValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const varOverridesSchema = z.record(z.string(), varValueSchema);
export const workspaceWorkflowVarsSchema = z.record(z.string(), varOverridesSchema);
export type WorkspaceWorkflowVars = z.infer<typeof workspaceWorkflowVarsSchema>;

export function validateVarOverrides(defaults: VarRecord, overrides: Readonly<Record<string, unknown>> | null | undefined): string[] {
  const errors: string[] = [];
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(defaults, name)) {
      errors.push(`${name}: the workflow declares no such var`);
    } else if (typeof value !== typeof defaults[name]) {
      errors.push(`${name}: expected ${typeof defaults[name]}, got ${typeof value}`);
    }
  }
  return errors;
}

function usable(defaults: VarRecord, name: string, overrides: VarRecord | null | undefined): VarValue | undefined {
  const value = overrides && Object.hasOwn(overrides, name) ? overrides[name] : undefined;
  return value !== undefined && typeof value === typeof defaults[name] ? value : undefined;
}

export function resolveVarSources(
  defaults: VarRecord,
  workspaceOverrides: VarRecord | null | undefined,
  ticketOverrides: VarRecord | null | undefined,
): Record<string, { value: VarValue; source: VarSource }> {
  const out: Record<string, { value: VarValue; source: VarSource }> = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const ticket = usable(defaults, name, ticketOverrides);
    const workspace = usable(defaults, name, workspaceOverrides);
    out[name] = ticket !== undefined ? { value: ticket, source: 'ticket' } : workspace !== undefined ? { value: workspace, source: 'workspace' } : { value: fallback, source: 'default' };
  }
  return out;
}

export function resolveVars(
  defaults: VarRecord,
  workspaceOverrides: VarRecord | null | undefined,
  ticketOverrides: VarRecord | null | undefined,
): Record<string, VarValue> {
  return Object.fromEntries(Object.entries(resolveVarSources(defaults, workspaceOverrides, ticketOverrides)).map(([name, entry]) => [name, entry.value]));
}

export function parseWorkspaceWorkflowVars(stored: string | null | undefined): WorkspaceWorkflowVars | null {
  if (!stored) return null;
  const parsed = workspaceWorkflowVarsSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : null;
}

export function workspaceVarsFor(workspace: { workflowVars?: string | null } | null, workflowName: string): VarRecord | null {
  return parseWorkspaceWorkflowVars(workspace?.workflowVars)?.[workflowName] ?? null;
}

export function snapshotVars(snapshot: VarRecord | null | undefined, defaults: VarRecord): VarRecord {
  return snapshot ?? defaults;
}
