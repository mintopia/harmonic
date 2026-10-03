import { z } from 'zod';
import { TRACKER_KINDS, trackerKindFor } from './kinds.js';

/** A Workspace's explicit issue-tracker choice: a kind id plus that kind's non-secret settings. */
export const configuredTrackerSchema = z
  .object({
    kind: z.string().min(1).meta({ example: 'gitlab' }),
    settings: z.record(z.string(), z.unknown()).optional().meta({ example: { project: 'group/repo' } }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const kind = trackerKindFor(value.kind);
    if (!kind) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: `Unknown tracker kind "${value.kind}" (known: ${TRACKER_KINDS.map((k) => k.id).join(', ')})` });
      return;
    }
    const parsed = kind.settings.safeParse(value.settings ?? {});
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['settings', ...issue.path], message: issue.message });
  });
export type ConfiguredTracker = z.infer<typeof configuredTrackerSchema>;
