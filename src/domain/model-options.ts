import type { WorkspaceRow } from '../db/schema.js';
import { CLASSIFIER_BACKENDS, DEFAULT_CLASSIFIER_TIMEOUT_SECONDS, DEFAULT_TYPESAFE_MODEL, modelOptionsSchema, type AppConfig, type ModelOption } from '../config.js';

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

export function parseModelOptions(stored: string | null | undefined): ModelOption[] | null {
  return stored == null ? null : modelOptionsSchema.parse(JSON.parse(stored));
}

/** The global options in order, then the Workspace's own; a Workspace can add but never remove a global one. */
export function resolveModelOptions(
  ws: ModelOptionWorkspace | null | undefined,
  config: Pick<AppConfig, 'modelOptions'>,
): ModelOption[] {
  return [...config.modelOptions, ...(parseModelOptions(ws?.modelOptions) ?? [])];
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
