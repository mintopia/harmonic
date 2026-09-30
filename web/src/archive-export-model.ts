import type { AppConfig, Workspace } from './types';

export interface RedactPatternRow {
  id: string;
  regex: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function patternIdError(id: string, siblings: readonly string[]): string | null {
  if (!ID_RE.test(id)) return 'Use lowercase letters, digits and dashes.';
  if (siblings.includes(id)) return 'Pattern ids must be unique.';
  return null;
}

export function patternRegexError(source: string): string | null {
  if (source.length === 0) return 'Enter a regular expression.';
  try {
    new RegExp(source, 'g');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'Invalid regular expression.';
  }
}

export function firstPatternError(rows: readonly RedactPatternRow[]): string | null {
  for (const [i, row] of rows.entries()) {
    const others = rows.filter((_, j) => j !== i).map((r) => r.id);
    const err = patternIdError(row.id, others) ?? patternRegexError(row.regex);
    if (err) return `Redaction pattern ${i + 1}: ${err}`;
  }
  return null;
}

const blankToNull = (v: string | null): string | null => (v === null || v === '' ? null : v);

export function normalizeConfigExport(config: AppConfig): AppConfig {
  const { s3, directory } = config.export;
  return {
    ...config,
    export: {
      ...config.export,
      directory: { path: blankToNull(directory.path) },
      s3: {
        ...s3,
        endpoint: blankToNull(s3.endpoint),
        region: blankToNull(s3.region),
        bucket: blankToNull(s3.bucket),
        accessKeyId: blankToNull(s3.accessKeyId),
        secretAccessKey: blankToNull(s3.secretAccessKey),
      },
    },
  };
}

export function normalizeWorkspaceExport(w: Workspace): Workspace {
  return {
    ...w,
    exportDirectoryPath: blankToNull(w.exportDirectoryPath),
    exportS3Endpoint: blankToNull(w.exportS3Endpoint),
    exportS3Region: blankToNull(w.exportS3Region),
    exportS3Bucket: blankToNull(w.exportS3Bucket),
    exportS3Prefix: blankToNull(w.exportS3Prefix),
    exportS3AccessKeyId: blankToNull(w.exportS3AccessKeyId),
    exportS3SecretAccessKey: blankToNull(w.exportS3SecretAccessKey),
    exportRedactPatterns: w.exportRedactPatterns && w.exportRedactPatterns.length > 0 ? w.exportRedactPatterns : null,
  };
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
