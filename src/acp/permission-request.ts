import { z } from 'zod';

const permissionRequestSchema = z
  .object({
    sessionId: z.string(),
    toolCall: z
      .object({
        toolCallId: z.string(),
        title: z.string().optional(),
        kind: z.string().optional(),
      })
      .passthrough(),
    options: z.array(
      z
        .object({
          optionId: z.string(),
          kind: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

/** Parses the ACP permission request boundary before a caller records or answers it. */
export function parsePermissionRequest(value: unknown): PermissionRequest | null {
  return permissionRequestSchema.safeParse(value).data ?? null;
}
