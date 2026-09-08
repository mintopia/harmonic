import { z } from 'zod';

/**
 * ACP form elicitations (`elicitation/create`, mode `form`) are how a harness
 * asks the operator a structured question mid-turn — the channel Claude's
 * `AskUserQuestion` tool and its refusal-fallback consent prompt travel over.
 * The wire `requestedSchema` is a JSON-Schema-shaped object; we parse it into a
 * flat, render-ready field model so the panel never has to interpret JSON
 * Schema, and the answer maps straight back onto the property keys.
 */

const optionMetaPreview = z
  .object({ '_claude/askUserQuestionOption': z.object({ preview: z.string() }).partial() })
  .partial();

const enumOptionSchema = z
  .object({
    const: z.union([z.string(), z.number(), z.boolean()]),
    title: z.string().optional(),
    description: z.string().optional(),
    _meta: optionMetaPreview.optional(),
  })
  .passthrough();

const propertySchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    oneOf: z.array(enumOptionSchema).optional(),
    items: z.object({ anyOf: z.array(enumOptionSchema).optional() }).passthrough().optional(),
  })
  .passthrough();

const createElicitationSchema = z
  .object({
    mode: z.string(),
    sessionId: z.string().optional(),
    toolCallId: z.string().nullish(),
    message: z.string(),
    requestedSchema: z
      .object({
        properties: z.record(z.string(), propertySchema).optional(),
        required: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ElicitationFieldKind = 'select' | 'multiselect' | 'text' | 'boolean';

export interface ElicitationOption {
  /** The enum `const` — the value written back into the answer content. */
  value: string;
  /** Human label (the option's `title`, falling back to its value). */
  label: string;
  description?: string;
  /** Rich focus content (mockups, code snippets) an option may carry. */
  preview?: string;
}

export interface ElicitationField {
  /** The schema property name — the key the answer is written under. */
  key: string;
  title?: string;
  description?: string;
  kind: ElicitationFieldKind;
  /** Present for `select` / `multiselect`. */
  options?: ElicitationOption[];
  /** True when the field is absent from the schema's `required` list. */
  optional: boolean;
}

export interface FormElicitationRequest {
  message: string;
  /** Set when the elicitation is tied to a specific tool call. */
  toolCallId?: string;
  fields: ElicitationField[];
}

/** The operator's answer to a form elicitation, mapped to an ACP response. */
export type ElicitationAnswer =
  | { action: 'accept'; content: Record<string, string | string[] | boolean> }
  | { action: 'decline' }
  | { action: 'cancel' };

function toOption(raw: z.infer<typeof enumOptionSchema>): ElicitationOption {
  const value = String(raw.const);
  return {
    value,
    label: raw.title ?? value,
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw._meta?.['_claude/askUserQuestionOption']?.preview
      ? { preview: raw._meta['_claude/askUserQuestionOption'].preview }
      : {}),
  };
}

function toField(key: string, prop: z.infer<typeof propertySchema>, required: Set<string>): ElicitationField {
  const base = {
    key,
    ...(prop.title ? { title: prop.title } : {}),
    ...(prop.description ? { description: prop.description } : {}),
    optional: !required.has(key),
  };
  if (prop.type === 'array' && prop.items?.anyOf?.length) {
    return { ...base, kind: 'multiselect', options: prop.items.anyOf.map(toOption) };
  }
  if (prop.oneOf?.length) {
    return { ...base, kind: 'select', options: prop.oneOf.map(toOption) };
  }
  if (prop.type === 'boolean') return { ...base, kind: 'boolean' };
  return { ...base, kind: 'text' };
}

/**
 * Parse an `elicitation/create` request into a render-ready form, or `null`
 * when it isn't a form we can present (a `url`-mode request, or a form with no
 * fields) — the caller then declines rather than leaving the harness hung.
 */
export function parseFormElicitation(value: unknown): FormElicitationRequest | null {
  const parsed = createElicitationSchema.safeParse(value).data;
  if (!parsed || parsed.mode !== 'form') return null;
  const properties = parsed.requestedSchema?.properties ?? {};
  const required = new Set(parsed.requestedSchema?.required ?? []);
  const fields = Object.entries(properties).map(([key, prop]) => toField(key, prop, required));
  if (fields.length === 0) return null;
  return {
    message: parsed.message,
    ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
    fields,
  };
}
