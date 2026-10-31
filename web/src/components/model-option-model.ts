import type { AppConfig, ModelOption } from '../types';
import { defaultHarnessId } from './verification-override-model';

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
    const m = key.match(/^modelOptions\.(\d+)(?:\.(id|harness|model|description))?$/);
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

/** The first saved row whose code is malformed or repeats an earlier code (globals first). */
export function firstModelOptionError(local: readonly ModelOption[] | null, globalIds: readonly string[] = []): string | null {
  const seen = [...globalIds];
  for (const [index, option] of (local ?? []).entries()) {
    const id = option.id.trim();
    if (!MODEL_OPTION_ID_PATTERN.test(id)) return `Model Option ${globalIds.length + index + 1}: code '${id}' must be lowercase letters, digits and hyphens.`;
    if (seen.includes(id)) return `Model Option ${globalIds.length + index + 1}: code '${id}' is already used.`;
    seen.push(id);
  }
  return null;
}
