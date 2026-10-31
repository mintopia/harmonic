import type { WorkspaceRow } from '../db/schema.js';
import { CLASSIFIER_BACKENDS, DEFAULT_CLASSIFIER_TIMEOUT_SECONDS, classifierEndpointSchema, modelOptionsSchema, type AppConfig, type ClassifierEndpoint, type ModelOption } from '../config.js';

export type ClassifierBackend = (typeof CLASSIFIER_BACKENDS)[number];

export interface ClassifierSettings {
  enabled: boolean;
  backend: ClassifierBackend;
  timeoutSeconds: number;
}

type ModelOptionWorkspace = Pick<WorkspaceRow, 'modelOptions'>;
type ClassifierWorkspace = Pick<WorkspaceRow, 'classifierEnabled' | 'classifierBackend' | 'classifierTimeoutSeconds'>;

export function parseClassifierEndpoint(stored: string | null | undefined): ClassifierEndpoint | null {
  return stored == null ? null : classifierEndpointSchema.parse(JSON.parse(stored));
}

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
  };
}
