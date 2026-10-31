import type { WorkspaceRow } from '../db/schema.js';
import { CLASSIFIER_BACKENDS, DEFAULT_CLASSIFIER_TIMEOUT_SECONDS, DEFAULT_TYPESAFE_MODEL, classifierEndpointSchema, modelOptionsSchema, type AppConfig, type ClassifierEndpoint, type ModelOption } from '../config.js';

export type ClassifierBackend = (typeof CLASSIFIER_BACKENDS)[number];

export interface ClassifierSettings {
  enabled: boolean;
  backend: ClassifierBackend;
  timeoutSeconds: number;
  typesafeModel: string;
  typesafeSecret: string | null;
}

type ModelOptionWorkspace = Pick<WorkspaceRow, 'modelOptions'>;
type ClassifierWorkspace = Pick<WorkspaceRow, 'classifierEnabled' | 'classifierBackend' | 'classifierTimeoutSeconds' | 'classifierTypesafeModel' | 'classifierTypesafeSecret'>;

export function parseClassifierEndpoint(stored: string | null | undefined): ClassifierEndpoint | null {
  return stored == null ? null : classifierEndpointSchema.parse(JSON.parse(stored));
}

export function parseModelOptions(stored: string | null | undefined): ModelOption[] | null {
  return stored == null ? null : modelOptionsSchema.parse(JSON.parse(stored));
}

export interface ModelOptionOverride {
  id: string;
  harness: string;
  model: string;
}

export type ModelOptionResolution =
  | { kind: 'found'; option: ModelOption; scope: 'ticket' | 'workspace' | 'global' }
  | { kind: 'miss'; reason: 'missing' | 'disabled'; code: string };

/** Workspace entries shadow global ones by code. */
function layered(ws: ModelOptionWorkspace | null | undefined, config: Pick<AppConfig, 'modelOptions'>) {
  const byCode = new Map<string, { option: ModelOption; scope: 'workspace' | 'global' }>();
  for (const option of config.modelOptions) byCode.set(option.id, { option, scope: 'global' });
  for (const option of parseModelOptions(ws?.modelOptions) ?? []) byCode.set(option.id, { option, scope: 'workspace' });
  return byCode;
}

/** Ticket > Workspace > global: global order first, shadowed codes replaced in place, Workspace-only codes appended, disabled codes dropped. */
export function resolveModelOptions(
  ws: ModelOptionWorkspace | null | undefined,
  config: Pick<AppConfig, 'modelOptions'>,
  ticketOverrides?: readonly ModelOptionOverride[] | null,
): ModelOption[] {
  const overrides = new Map((ticketOverrides ?? []).map((o) => [o.id, o]));
  return [...layered(ws, config).values()]
    .filter(({ option }) => !option.disabled)
    .map(({ option }) => {
      const override = overrides.get(option.id);
      return override ? { ...option, harness: override.harness, model: override.model } : option;
    });
}

export function resolveModelOption(
  code: string,
  from: { ticketOverrides?: readonly ModelOptionOverride[] | null; workspace?: ModelOptionWorkspace | null | undefined; config: Pick<AppConfig, 'modelOptions'> },
): ModelOptionResolution {
  const entry = layered(from.workspace, from.config).get(code);
  if (!entry) return { kind: 'miss', reason: 'missing', code };
  if (entry.option.disabled) return { kind: 'miss', reason: 'disabled', code };
  const override = from.ticketOverrides?.find((o) => o.id === code);
  if (override) return { kind: 'found', option: { ...entry.option, harness: override.harness, model: override.model }, scope: 'ticket' };
  return { kind: 'found', option: entry.option, scope: entry.scope };
}

/** True when the code is defined in the Workspace overlay or the global list, disabled or not. */
export function isModelOptionDefined(code: string, ws: ModelOptionWorkspace | null | undefined, config: Pick<AppConfig, 'modelOptions'>): boolean {
  return layered(ws, config).has(code);
}

export function resolveClassifierSettings(ws: ClassifierWorkspace | null | undefined): ClassifierSettings {
  return {
    enabled: ws?.classifierEnabled ?? false,
    backend: ws?.classifierBackend ?? 'harness',
    timeoutSeconds: ws?.classifierTimeoutSeconds ?? DEFAULT_CLASSIFIER_TIMEOUT_SECONDS,
    typesafeModel: ws?.classifierTypesafeModel ?? DEFAULT_TYPESAFE_MODEL,
    typesafeSecret: ws?.classifierTypesafeSecret ?? null,
  };
}
