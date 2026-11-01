import type { WorkspaceRow } from '../db/schema.js';
import { CLASSIFIER_BACKENDS, classifierEndpointSchema, modelOptionOverrideSchema, type AppConfig, type ClassifierEndpoint, type ModelOption, type ModelOptionOverlayEntry } from '../config.js';
import { mergeOverlay } from './setting-override.js';

export type ClassifierBackend = (typeof CLASSIFIER_BACKENDS)[number];

export interface ClassifierSettings {
  enabled: boolean;
  backend: ClassifierBackend;
  timeoutSeconds: number;
  typesafeModel: string;
  typesafeSecret: string | null;
  harness: string | null;
  model: string | null;
}

type ModelOptionWorkspace = Pick<WorkspaceRow, 'modelOptions'>;
type ClassifierWorkspace = Pick<WorkspaceRow, 'classifierEnabled' | 'classifierBackend' | 'classifierTimeoutSeconds' | 'classifierTypesafeModel' | 'classifierTypesafeSecret' | 'classifierHarness' | 'classifierModel'>;

export function parseClassifierEndpoint(stored: string | null | undefined): ClassifierEndpoint | null {
  return stored == null ? null : classifierEndpointSchema.parse(JSON.parse(stored));
}

export function parseModelOptionOverlay(stored: string | null | undefined): ModelOptionOverlayEntry[] | null {
  return stored == null ? null : modelOptionOverrideSchema.parse(JSON.parse(stored));
}

export interface ModelOptionOverride {
  id: string;
  harness: string;
  model: string;
}

export type ModelOptionResolution =
  | { kind: 'found'; option: ModelOption; scope: 'ticket' | 'workspace' | 'global' }
  | { kind: 'miss'; reason: 'missing' | 'disabled'; code: string };

type Layered = { option: ModelOption; scope: 'workspace' | 'global'; enabled: boolean };

function layered(ws: ModelOptionWorkspace | null | undefined, config: Pick<AppConfig, 'modelOptions'>): Map<string, Layered> {
  const byCode = new Map<string, Layered>();
  for (const option of config.modelOptions) byCode.set(option.id, { option, scope: 'global', enabled: true });
  for (const entry of parseModelOptionOverlay(ws?.modelOptions) ?? []) {
    if (entry.kind === 'local') byCode.set(entry.modelOption.id, { option: entry.modelOption, scope: 'workspace', enabled: entry.enabled });
    else if (byCode.has(entry.ref)) byCode.set(entry.ref, { ...byCode.get(entry.ref)!, enabled: entry.enabled });
  }
  return byCode;
}

function withOverride(option: ModelOption, overrides: ReadonlyMap<string, ModelOptionOverride>): ModelOption {
  const override = overrides.get(option.id);
  return override ? { ...option, harness: override.harness, model: override.model } : option;
}

/** The enabled options in overlay order (ADR-0037), with Ticket overrides applied; no overlay inherits every global, and a global the overlay omits is appended. */
export function resolveModelOptions(
  ws: ModelOptionWorkspace | null | undefined,
  config: Pick<AppConfig, 'modelOptions'>,
  ticketOverrides?: readonly ModelOptionOverride[] | null,
): ModelOption[] {
  const overrides = new Map((ticketOverrides ?? []).map((o) => [o.id, o]));
  return mergeOverlay<ModelOption, ModelOptionOverlayEntry>(parseModelOptionOverlay(ws?.modelOptions), config.modelOptions, (o) => o.id, (e) => e.ref, (e) => e.modelOption)
    .map((option) => withOverride(option, overrides));
}

export function resolveModelOption(
  code: string,
  from: { ticketOverrides?: readonly ModelOptionOverride[] | null; workspace?: ModelOptionWorkspace | null | undefined; config: Pick<AppConfig, 'modelOptions'> },
): ModelOptionResolution {
  const entry = layered(from.workspace, from.config).get(code);
  if (!entry) return { kind: 'miss', reason: 'missing', code };
  if (!entry.enabled) return { kind: 'miss', reason: 'disabled', code };
  const override = from.ticketOverrides?.find((o) => o.id === code);
  if (override) return { kind: 'found', option: withOverride(entry.option, new Map([[code, override]])), scope: 'ticket' };
  return { kind: 'found', option: entry.option, scope: entry.scope };
}

/** True when the code is a global or a Workspace overlay entry, enabled or not. */
export function isModelOptionDefined(code: string, ws: ModelOptionWorkspace | null | undefined, config: Pick<AppConfig, 'modelOptions'>): boolean {
  return layered(ws, config).has(code);
}

export function resolveClassifierSettings(ws: ClassifierWorkspace | null | undefined, config: Pick<AppConfig, 'classifier'>): ClassifierSettings {
  const global = config.classifier;
  return {
    enabled: ws?.classifierEnabled ?? global.enabled,
    backend: ws?.classifierBackend ?? global.backend,
    timeoutSeconds: ws?.classifierTimeoutSeconds ?? global.timeoutSeconds,
    typesafeModel: ws?.classifierTypesafeModel ?? global.typesafeModel,
    typesafeSecret: ws?.classifierTypesafeSecret ?? global.typesafeSecret,
    harness: ws?.classifierHarness ?? global.harness,
    model: ws?.classifierModel ?? (ws?.classifierHarness ? null : global.model),
  };
}

export function resolveWorkflowClassifierEnabled(ws: Pick<WorkspaceRow, 'workflowClassifierEnabled'> | null | undefined, config: Pick<AppConfig, 'classifier'>): boolean {
  return ws?.workflowClassifierEnabled ?? config.classifier.workflowEnabled;
}
