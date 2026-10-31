import type { AppConfig, ModelOption, ModelOptionOverlayEntry } from '../types';
import { defaultHarnessId, withMissingGlobals } from './verification-override-model';

export const MODEL_OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const DESCRIPTION_LIMIT = 400;

export type ModelOptionField = 'id' | 'harness' | 'model' | 'description';
export type ModelOptionErrors = Partial<Record<ModelOptionField, string>>;

export function blankModelOption(config: AppConfig): ModelOption {
  const harness = defaultHarnessId(config);
  return { id: '', harness, model: config.harnesses[harness]?.defaultModel ?? '', description: '' };
}

/** Why `draft` cannot be saved. `taken` are the other ids in resolved-list order. */
export function validateModelOption(draft: ModelOption, taken: readonly string[], config: AppConfig): ModelOptionErrors {
  const errors: ModelOptionErrors = {};
  const id = draft.id.trim();
  const clash = taken.indexOf(id);
  if (id === '') errors.id = 'Code is required.';
  else if (!MODEL_OPTION_ID_PATTERN.test(id)) errors.id = 'Codes are lowercase letters, digits and hyphens, starting with a letter or digit.';
  else if (clash !== -1) errors.id = `Code '${id}' is already used by Model Option ${clash + 1}. Codes must be unique.`;
  const harness = config.harnesses[draft.harness];
  if (!harness) errors.harness = `Harness '${draft.harness}' is not configured. Configure it in Settings › Integrations, or pick a different Harness.`;
  const model = draft.model.trim();
  if (model === '') errors.model = 'Model is required.';
  else if (harness && harness.models.length > 0 && !harness.models.some((m) => m.id === model)) {
    errors.model = `Model '${model}' is not in the ${draft.harness} model catalog. A Model Option must name a Model the Harness offers.`;
  }
  if (draft.description.trim() === '') errors.description = 'Describe when it fits; the classifier reads this to choose.';
  return errors;
}

/** Server refusals (`modelOptions.<i>.<field>: msg`) grouped by row index. */
export function serverRowErrors(errors: Record<string, string>, offset = 0): Map<number, ModelOptionErrors & { row?: string }> {
  const out = new Map<number, ModelOptionErrors & { row?: string }>();
  for (const [key, message] of Object.entries(errors)) {
    const m = key.match(/^modelOptions\.(\d+)(?:\.modelOption)?(?:\.(id|harness|model|description))?$/);
    if (!m) continue;
    const index = Number(m[1]) + offset;
    const row = out.get(index) ?? {};
    if (m[2]) row[m[2] as ModelOptionField] = message;
    else row.row = message;
    out.set(index, row);
  }
  return out;
}

export function firstServerMessage(row: (ModelOptionErrors & { row?: string }) | undefined): string | null {
  return row ? (row.row ?? row.id ?? row.harness ?? row.model ?? row.description ?? null) : null;
}

/** One displayed Model Option row: a Global row carries the global option it points at, or none when that global was removed. */
export type ModelOptionRow =
  | { kind: 'global'; ref: string; enabled: boolean; option: ModelOption }
  | { kind: 'local'; enabled: boolean; option: ModelOption };

/** The overlay as displayed: any global it does not name is appended enabled, and a ref to a removed global is dropped. */
export function modelOptionRows(overlay: readonly ModelOptionOverlayEntry[] | null, globals: readonly ModelOption[]): ModelOptionRow[] {
  const byId = new Map(globals.map((g) => [g.id, g]));
  return withMissingGlobals<ModelOptionOverlayEntry>(overlay, globals.map((g) => g.id)).flatMap((entry): ModelOptionRow[] => {
    if (entry.kind === 'local') return [{ kind: 'local', enabled: entry.enabled, option: entry.modelOption }];
    const option = byId.get(entry.ref);
    return option ? [{ kind: 'global', ref: entry.ref, enabled: entry.enabled, option }] : [];
  });
}

export function rowsToOverlay(rows: readonly ModelOptionRow[]): ModelOptionOverlayEntry[] {
  return rows.map((row): ModelOptionOverlayEntry =>
    row.kind === 'global' ? { kind: 'global', ref: row.ref, enabled: row.enabled } : { kind: 'local', enabled: row.enabled, modelOption: row.option },
  );
}

/** How many Model Options the classifier would see: the enabled rows. */
export function enabledOptionCount(overlay: readonly ModelOptionOverlayEntry[] | null, globals: readonly ModelOption[]): number {
  return modelOptionRows(overlay, globals).filter((row) => row.enabled).length;
}

/** The first Workspace-local row whose code is malformed or repeats another row's code (Global rows first). */
export function firstModelOptionError(overlay: readonly ModelOptionOverlayEntry[] | null, globals: readonly ModelOption[] = []): string | null {
  const rows = modelOptionRows(overlay, globals);
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const id = row.option.id.trim();
    if (row.kind === 'local' && !MODEL_OPTION_ID_PATTERN.test(id)) return `Model Option ${index + 1}: code '${id}' must be lowercase letters, digits and hyphens.`;
    if (seen.has(id)) return `Model Option ${index + 1}: code '${id}' is already used.`;
    seen.add(id);
  }
  return null;
}

/** Same check for the Global list, which is a plain array of options. */
export function firstGlobalModelOptionError(options: readonly ModelOption[]): string | null {
  return firstModelOptionError(options.map((modelOption) => ({ kind: 'local' as const, enabled: true, modelOption })));
}
