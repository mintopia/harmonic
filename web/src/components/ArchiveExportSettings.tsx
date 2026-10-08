import { useState, type ReactNode } from 'react';
import { api } from '../api';
import type { AppConfig, ExportDestinationTestResult, ExportState, Workspace } from '../types';
import { btnGhost, btnQuiet, field, labelType } from '../ui';
import { patternIdError, patternRegexError, relativeTime, type RedactPatternRow } from '../archive-export-model';
import { Icon } from './Icon';
import { FieldError } from './SettingsSection';
import { LayerField } from './LayerField';
import { Switch } from './Switch';
import type { RenderCtx, WorkspaceRenderCtx } from './settings-schema';
import { SECRET_MASK } from '../../../src/archive/export-secrets.js';
import { BASELINE_REDACT_PATTERNS } from '../../../src/archive/redact.js';

type Col = 'enabled' | 'dirPath' | 'endpoint' | 'region' | 'bucket' | 'prefix' | 'forcePathStyle' | 'accessKeyId' | 'secretAccessKey';
type Value = string | boolean;

const withS3 = (c: AppConfig, patch: Partial<AppConfig['export']['s3']>): AppConfig => ({
  ...c,
  export: { ...c.export, s3: { ...c.export.s3, ...patch } },
});

const COLS: Record<Col, { ws: keyof Workspace; err: string; get: (c: AppConfig) => Value; set: (c: AppConfig, v: Value) => AppConfig }> = {
  enabled: { ws: 'exportEnabled', err: 'export.enabled', get: (c) => c.export.enabled, set: (c, v) => ({ ...c, export: { ...c.export, enabled: Boolean(v) } }) },
  dirPath: { ws: 'exportDirectoryPath', err: 'export.directory.path', get: (c) => c.export.directory.path ?? '', set: (c, v) => ({ ...c, export: { ...c.export, directory: { path: String(v) } } }) },
  endpoint: { ws: 'exportS3Endpoint', err: 'export.s3.endpoint', get: (c) => c.export.s3.endpoint ?? '', set: (c, v) => withS3(c, { endpoint: String(v) }) },
  region: { ws: 'exportS3Region', err: 'export.s3.region', get: (c) => c.export.s3.region ?? '', set: (c, v) => withS3(c, { region: String(v) }) },
  bucket: { ws: 'exportS3Bucket', err: 'export.s3.bucket', get: (c) => c.export.s3.bucket ?? '', set: (c, v) => withS3(c, { bucket: String(v) }) },
  prefix: { ws: 'exportS3Prefix', err: 'export.s3.prefix', get: (c) => c.export.s3.prefix, set: (c, v) => withS3(c, { prefix: String(v) }) },
  forcePathStyle: { ws: 'exportS3ForcePathStyle', err: 'export.s3.forcePathStyle', get: (c) => c.export.s3.forcePathStyle, set: (c, v) => withS3(c, { forcePathStyle: Boolean(v) }) },
  accessKeyId: { ws: 'exportS3AccessKeyId', err: 'export.s3.accessKeyId', get: (c) => c.export.s3.accessKeyId ?? '', set: (c, v) => withS3(c, { accessKeyId: String(v) }) },
  secretAccessKey: { ws: 'exportS3SecretAccessKey', err: 'export.s3.secretAccessKey', get: (c) => c.export.s3.secretAccessKey ?? '', set: (c, v) => withS3(c, { secretAccessKey: String(v) }) },
};

function wsColumn(col: Col, workspace: Workspace): Value | null {
  return (workspace[COLS[col].ws] as Value | null | undefined) ?? null;
}

function setWsColumn(ctx: WorkspaceRenderCtx, col: Col, value: Value | null) {
  ctx.setWorkspace({ ...ctx.workspace, [COLS[col].ws]: value });
}

function effectiveRaw(ctx: RenderCtx, col: 'dirPath' | 'bucket'): string | null {
  if (ctx.surface === 'global') return col === 'dirPath' ? ctx.config.export.directory.path : ctx.config.export.s3.bucket;
  const own = wsColumn(col, ctx.workspace) as string | null;
  if (own !== null) return own;
  return col === 'dirPath' ? ctx.config.export.directory.path : ctx.config.export.s3.bucket;
}

function SecretControl({ id, label, value, onChange, onCancel }: { id?: string; label: string; value: string; onChange: (v: string) => void; onCancel: () => void }) {
  const [replacing, setReplacing] = useState(false);
  if (value === SECRET_MASK) {
    return (
      <div className="flex items-center gap-2.5">
        <input id={id} className={`${field} font-data text-[13px]`} disabled value="••••••••••••••••" aria-label={`${label} (masked, stored)`} readOnly />
        <button
          type="button"
          className={btnGhost}
          onClick={() => {
            setReplacing(true);
            onChange('');
          }}
        >
          Replace
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className={`${field} font-data text-[13px]`}
        value={value}
        placeholder={replacing ? 'Enter the new value' : 'Not set'}
        onChange={(e) => onChange(e.target.value)}
      />
      {replacing && (
        <button
          type="button"
          className={btnGhost}
          onClick={() => {
            setReplacing(false);
            onCancel();
          }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

function displayValue(v: Value | null, kind: 'text' | 'toggle' | 'secret'): ReactNode {
  if (kind === 'toggle') return v ? 'On' : 'Off';
  if (kind === 'secret') return v === SECRET_MASK ? <><span className="font-data text-[13px]">••••••••</span> <span className="text-small text-muted">(set)</span></> : 'Not set';
  return v === null || v === '' ? 'Not set' : <span className="font-data text-[13px]">{String(v)}</span>;
}

function WsShell({
  label,
  htmlFor,
  help,
  overridden,
  display,
  onOverride,
  onReset,
  locked,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: string;
  overridden: boolean;
  display: ReactNode;
  onOverride?: (on: boolean) => void;
  onReset?: () => void;
  locked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex min-h-6 items-center gap-2">
        <label className={`${labelType} whitespace-nowrap text-muted`} htmlFor={htmlFor}>{label}</label>
        {overridden && <span className="shrink-0 text-small text-running">Modified</span>}
        <span className="ml-auto" title={locked ? 'Set in Global settings' : undefined}>
          <Switch checked={overridden} onChange={(on) => onOverride?.(on)} label={`Override ${label}`} disabled={locked} />
        </span>
      </div>
      {help && <p className="mb-1.5 text-small text-muted">{help}</p>}
      {overridden ? (
        <>
          {children}
          <p className="mt-1.5 text-small text-ink">{display} <span className="text-muted">· Overridden here</span></p>
          <button type="button" className={`${btnQuiet} min-h-0 py-0.5 text-label`} onClick={onReset}>Reset to default</button>
        </>
      ) : (
        <p className="text-ink">{display} <span className="text-small text-muted">· Inherited from global default</span></p>
      )}
    </div>
  );
}

function BoundField({
  ctx,
  col,
  label,
  htmlFor,
  kind,
  help,
  placeholder,
}: {
  ctx: RenderCtx;
  col: Col;
  label: string;
  htmlFor: string;
  kind: 'text' | 'toggle' | 'secret';
  help?: string;
  placeholder?: string;
}) {
  const spec = COLS[col];
  const renderControl = (id: string | undefined, v: Value, change: (v: Value) => void, cancel: () => void) =>
    kind === 'toggle' ? (
      <div className="pt-1">
        <Switch checked={Boolean(v)} onChange={change} label={label} />
      </div>
    ) : kind === 'secret' ? (
      <SecretControl id={id} label={label} value={String(v)} onChange={change} onCancel={cancel} />
    ) : (
      <input id={id} className={`${field} font-data text-[13px]`} value={String(v)} placeholder={placeholder} spellCheck={false} onChange={(e) => change(e.target.value)} />
    );

  if (ctx.surface === 'workspace') {
    const own = wsColumn(col, ctx.workspace);
    const inheritedValue = spec.get(ctx.config);
    const reset = () => setWsColumn(ctx, col, null);
    const cancel = wsColumn(col, ctx.pristineWorkspace) === null ? reset : () => setWsColumn(ctx, col, SECRET_MASK);
    const raw = own ?? inheritedValue;
    return (
      <div>
        <WsShell
          label={label}
          htmlFor={kind === 'toggle' ? undefined : htmlFor}
          help={help}
          overridden={own !== null}
          display={displayValue(kind === 'text' && raw === '' ? null : raw, kind)}
          onOverride={(on) => setWsColumn(ctx, col, on ? (kind === 'secret' ? '' : inheritedValue) : null)}
          onReset={reset}
        >
          {renderControl(htmlFor, raw, (v) => setWsColumn(ctx, col, v), cancel)}
        </WsShell>
        <FieldError message={ctx.errors[String(spec.ws)]} />
      </div>
    );
  }

  const inheritedValue = spec.get(ctx.baseline);
  const value = spec.get(ctx.config);
  return (
    <div>
      <LayerField<Value>
        label={label}
        htmlFor={kind === 'toggle' ? undefined : htmlFor}
        value={value}
        inheritedValue={inheritedValue}
        inherited={value === inheritedValue}
        onChange={(v) => ctx.setConfig(spec.set(ctx.config, v))}
        onRevert={() => ctx.setConfig(spec.set(ctx.config, inheritedValue))}
      >
        {({ id, value: v, onChange: change }) => (
          <>
            {help && <p className="mb-1.5 text-small text-muted">{help}</p>}
            {renderControl(id, v, change, () => ctx.setConfig(spec.set(ctx.config, SECRET_MASK)))}
          </>
        )}
      </LayerField>
      <FieldError message={ctx.errors[spec.err]} />
    </div>
  );
}

function NullableNumberField({ ctx, label, htmlFor, help, placeholder, get, set, errorKey, wsKey, seed }: {
  ctx: RenderCtx;
  label: string;
  htmlFor: string;
  help: string;
  placeholder: string;
  get: (c: AppConfig) => number | null;
  set: (c: AppConfig, v: number | null) => AppConfig;
  errorKey: string;
  wsKey: 'archiveRetentionDays' | 'archiveRetentionMaxTotalMB';
  seed: number;
}) {
  if (ctx.surface !== 'global') {
    const own = ctx.workspace[wsKey];
    const inherited = get(ctx.config);
    const setOwn = (v: number | null) => ctx.setWorkspace({ ...ctx.workspace, [wsKey]: v });
    const shown = own ?? inherited;
    return (
      <div>
        <WsShell
          label={label}
          htmlFor={htmlFor}
          help={help}
          overridden={own !== null}
          display={shown === null ? (placeholder.startsWith('Forever') ? 'Forever' : 'Unlimited') : shown}
          onOverride={(on) => setOwn(on ? (inherited ?? seed) : null)}
          onReset={() => setOwn(null)}
        >
          <input
            id={htmlFor}
            type="number"
            min={1}
            inputMode="numeric"
            className={`${field} tabular-nums`}
            value={own ?? ''}
            onChange={(e) => e.target.value !== '' && setOwn(Number(e.target.value))}
          />
        </WsShell>
        <FieldError message={ctx.errors[wsKey]} />
      </div>
    );
  }
  const value = get(ctx.config);
  const base = get(ctx.baseline);
  return (
    <div>
      <LayerField<number | null>
        label={label}
        htmlFor={htmlFor}
        value={value}
        inheritedValue={base}
        inherited={value === base}
        dim={false}
        onChange={(v) => ctx.setConfig(set(ctx.config, v))}
        onRevert={() => ctx.setConfig(set(ctx.config, base))}
      >
        {({ id, value: v, onChange }) => (
          <>
            <p className="mb-1.5 text-small text-muted">{help}</p>
            <input
              id={id}
              type="number"
              min={1}
              inputMode="numeric"
              className={`${field} tabular-nums`}
              value={v ?? ''}
              placeholder={placeholder}
              onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            />
          </>
        )}
      </LayerField>
      <FieldError message={ctx.errors[errorKey]} />
    </div>
  );
}

export function ArchiveRetentionSection({ ctx }: { ctx: RenderCtx }) {
  return (
    <div className="flex flex-col gap-4.5">
      <NullableNumberField
        ctx={ctx}
        label="Keep for (days)"
        htmlFor="archive-retain-days"
        help="Oldest terminal Archives past this age are pruned. Blank = keep forever."
        placeholder="Forever (blank)"
        get={(c) => c.archive.retain.days}
        set={(c, v) => ({ ...c, archive: { retain: { ...c.archive.retain, days: v } } })}
        errorKey="archive.retain.days"
        wsKey="archiveRetentionDays"
        seed={90}
      />
      <NullableNumberField
        ctx={ctx}
        label="Max total size (MB)"
        htmlFor="archive-retain-mb"
        help="When the Archive tree exceeds this, oldest terminal Archives go first. Blank = unlimited."
        placeholder="Unlimited (blank)"
        get={(c) => c.archive.retain.maxTotalMB}
        set={(c, v) => ({ ...c, archive: { retain: { ...c.archive.retain, maxTotalMB: v } } })}
        errorKey="archive.retain.maxTotalMB"
        wsKey="archiveRetentionMaxTotalMB"
        seed={1024}
      />
    </div>
  );
}

const STATES: ExportState[] = ['done', 'cancelled', 'deleted'];

function StateChips({ value, onChange }: { value: ExportState[]; onChange: (next: ExportState[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dispositions to export">
      {STATES.map((s) => {
        const on = value.includes(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== s) : STATES.filter((x) => x === s || value.includes(x)))}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-[3px] border px-2.5 font-data text-[13px] transition-colors duration-150 ${
              on ? 'border-transparent bg-accent-tint font-semibold text-accent' : 'border-edge bg-surface text-muted hover:border-accent'
            }`}
          >
            {on && <Icon name="check" className="size-3" />}
            {s}
          </button>
        );
      })}
    </div>
  );
}

function DispositionChips({ ctx }: { ctx: RenderCtx }) {
  const help = 'Deleting a Task exports it first when it has at least one Attempt.';
  const key = (s: ExportState[]) => STATES.filter((x) => s.includes(x)).join(',');
  if (ctx.surface === 'workspace') {
    const own = ctx.workspace.exportIncludeStates;
    const inherited = ctx.config.export.includeStates;
    const setOwn = (v: ExportState[] | null) => ctx.setWorkspace({ ...ctx.workspace, exportIncludeStates: v });
    const shown = own ?? inherited;
    return (
      <div>
        <WsShell
          label="Dispositions to export"
          help={help}
          overridden={own !== null}
          display={<span className="font-data text-[13px]">{key(shown) || 'none'}</span>}
          onOverride={(on) => setOwn(on ? [...inherited] : null)}
          onReset={() => setOwn(null)}
        >
          <StateChips value={shown} onChange={setOwn} />
        </WsShell>
        <FieldError message={ctx.errors.exportIncludeStates} />
      </div>
    );
  }
  const value = ctx.config.export.includeStates;
  const base = ctx.baseline.export.includeStates;
  const setStates = (next: ExportState[]) => ctx.setConfig({ ...ctx.config, export: { ...ctx.config.export, includeStates: next } });
  return (
    <div>
      <LayerField<ExportState[]>
        label="Dispositions to export"
        value={value}
        inheritedValue={base}
        inherited={key(value) === key(base)}
        dim={false}
        onChange={setStates}
        onRevert={() => setStates(base)}
      >
        {({ value: v, onChange }) => (
          <>
            <p className="mb-1.5 text-small text-muted">{help}</p>
            <StateChips value={v} onChange={onChange} />
          </>
        )}
      </LayerField>
      <FieldError message={ctx.errors['export.includeStates']} />
    </div>
  );
}

export function ExportSection({ ctx }: { ctx: RenderCtx }) {
  return (
    <div className="flex flex-col gap-4.5">
      <BoundField ctx={ctx} col="enabled" label="Export on terminal disposition" htmlFor="export-enabled" kind="toggle" help="An Export never blocks or reverts the disposition." />
      <DispositionChips ctx={ctx} />
    </div>
  );
}

function DestinationCard({
  ctx,
  destination,
  title,
  icon,
  enabled,
  configured,
  onEnabled,
  probeHint,
  children,
}: {
  ctx: RenderCtx;
  destination: 'directory' | 's3';
  title: string;
  icon: 'files' | 'arrow-up-right';
  enabled: boolean;
  configured: boolean;
  onEnabled: (on: boolean) => void;
  probeHint: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportDestinationTestResult | null>(null);
  const dirty = ctx.dirty ?? false;

  const test = async () => {
    setBusy(true);
    try {
      setResult(
        await api.testExportDestination({
          workspaceId: ctx.surface === 'workspace' ? ctx.pristineWorkspace.id : null,
          destination,
        }),
      );
    } catch (e) {
      setResult({ destination, ok: false, error: e instanceof Error ? e.message : String(e), testedAt: new Date().toISOString() });
    } finally {
      setBusy(false);
    }
  };

  const [detail, message] = result?.error?.split(/:\s(.*)/s) ?? [];
  return (
    <div className="overflow-hidden rounded border border-hairline bg-surface" role="group" aria-label={`${title} Destination`}>
      <header className="flex items-center gap-2.5 border-b border-hairline px-3.5 py-3">
        <Icon name={icon} />
        <span className="font-semibold">{title}</span>
        <span className="ml-auto">
          <Switch checked={enabled} onChange={onEnabled} label={`Enable ${title} Destination`} />
        </span>
      </header>
      <div className={`flex flex-col gap-3.5 p-3.5 ${enabled ? '' : 'opacity-55'}`}>{children}</div>
      <footer className="flex flex-col gap-2.5 border-t border-hairline bg-sunken px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnGhost} disabled={busy || dirty || !configured} title={dirty ? 'Save changes to test them' : undefined} onClick={test}>
            {busy ? 'Testing…' : 'Test Destination'}
          </button>
          <span className="text-small text-muted">{probeHint}</span>
        </div>
        {result &&
          (result.ok ? (
            <div role="status" className="flex items-start gap-2 text-small text-merged">
              <Icon name="check" className="mt-px size-3.5" />
              <span>{destination === 'directory' ? 'Wrote and removed probe object' : 'Wrote and removed probe object'}</span>
              <span className="ml-auto whitespace-nowrap text-faint">{relativeTime(result.testedAt)}</span>
            </div>
          ) : (
            <div role="alert" className="flex items-start gap-2 rounded-[3px] bg-fail-tint px-2.5 py-2 text-small text-fail">
              <Icon name="close" className="mt-px size-3.5" />
              <span>
                {message !== undefined && detail !== 'Error' ? <><b className="font-semibold">{detail}:</b> {message}</> : (result.error ?? 'Test failed')}
              </span>
              <span className="ml-auto whitespace-nowrap opacity-80">{relativeTime(result.testedAt)}</span>
            </div>
          ))}
      </footer>
    </div>
  );
}

export function DestinationsSection({ ctx }: { ctx: RenderCtx }) {
  const toggle = (col: 'dirPath' | 'bucket') => (on: boolean) => {
    const next = on ? '' : null;
    if (ctx.surface === 'workspace') {
      setWsColumn(ctx, col, next);
      return;
    }
    ctx.setConfig(
      col === 'dirPath'
        ? { ...ctx.config, export: { ...ctx.config.export, directory: { path: next } } }
        : withS3(ctx.config, { bucket: next }),
    );
  };
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <DestinationCard
        ctx={ctx}
        destination="directory"
        title="Directory"
        icon="files"
        enabled={effectiveRaw(ctx, 'dirPath') !== null}
        configured={(effectiveRaw(ctx, 'dirPath') ?? '') !== ''}
        onEnabled={toggle('dirPath')}
        probeHint="Writes and removes a probe object."
      >
        <BoundField ctx={ctx} col="dirPath" label="Path" htmlFor="export-dir-path" kind="text" placeholder="/var/lib/harmonic/exports" help="Absolute path on the Harmonic host. Created if missing; existing files are never overwritten." />
      </DestinationCard>
      <DestinationCard
        ctx={ctx}
        destination="s3"
        title="S3-compatible"
        icon="arrow-up-right"
        enabled={effectiveRaw(ctx, 'bucket') !== null}
        configured={(effectiveRaw(ctx, 'bucket') ?? '') !== ''}
        onEnabled={toggle('bucket')}
        probeHint="Uses the effective settings above."
      >
        <BoundField ctx={ctx} col="endpoint" label="Endpoint" htmlFor="export-s3-endpoint" kind="text" placeholder="https://minio.internal:9000" help="Leave blank for AWS. Set for MinIO, R2, Ceph and similar." />
        <div className="grid gap-3 sm:grid-cols-2">
          <BoundField ctx={ctx} col="region" label="Region" htmlFor="export-s3-region" kind="text" placeholder="us-east-1" />
          <BoundField ctx={ctx} col="bucket" label="Bucket" htmlFor="export-s3-bucket" kind="text" placeholder="bucket-name" />
        </div>
        <BoundField ctx={ctx} col="prefix" label="Prefix" htmlFor="export-s3-prefix" kind="text" placeholder="optional/key/prefix/" />
        <BoundField ctx={ctx} col="forcePathStyle" label="Force path-style" htmlFor="export-s3-path" kind="toggle" help="Needed by most MinIO and self-hosted setups." />
        <div className="grid gap-3 sm:grid-cols-2">
          <BoundField ctx={ctx} col="accessKeyId" label="Access key ID" htmlFor="export-s3-ak" kind="secret" />
          <BoundField ctx={ctx} col="secretAccessKey" label="Secret access key" htmlFor="export-s3-sk" kind="secret" />
        </div>
        <p className="-mt-1.5 text-small text-muted">Leave both blank to use the AWS default credential chain. Keys are masked and never shown again after saving.</p>
      </DestinationCard>
    </div>
  );
}

const BASELINE_DESCRIPTIONS: Record<string, string> = {
  'aws-access-key': 'AKIA / ASIA access key IDs',
  'aws-secret-key': '40-character secret next to an AWS key name',
  'github-token': 'ghp_, gho_, ghs_, github_pat_ tokens',
  'gitlab-token': 'glpat- personal and project tokens',
  bearer: 'Authorization: Bearer … header values',
  'sk-api-key': 'sk- prefixed provider API keys',
};

function PatternRows({ rows, offset, onChange, serverError }: { rows: RedactPatternRow[]; offset: number; onChange: (rows: RedactPatternRow[]) => void; serverError: (i: number) => string | undefined }) {
  const patch = (i: number, p: Partial<RedactPatternRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Added redaction patterns">
      {rows.map((row, i) => {
        const n = offset + i + 1;
        const idError = row.id === '' ? null : patternIdError(row.id, rows.filter((_, j) => j !== i).map((r) => r.id));
        const reError = row.regex === '' ? null : patternRegexError(row.regex);
        const error = idError ?? reError ?? serverError(i);
        return (
          <li key={i}>
            <div className="flex items-center gap-2.5">
              <input className={`${field} basis-1/3 font-data text-[13px]`} aria-label={`Pattern id ${n}`} aria-invalid={idError !== null} spellCheck={false} value={row.id} placeholder="pattern-id" onChange={(e) => patch(i, { id: e.target.value })} />
              <input className={`${field} flex-1 font-data text-[13px]`} aria-label={`Regular expression ${n}`} aria-invalid={reError !== null} spellCheck={false} value={row.regex} placeholder="regular expression" onChange={(e) => patch(i, { regex: e.target.value })} />
              <button type="button" className={`${btnQuiet} w-11 shrink-0 justify-center hover:text-fail`} aria-label={`Remove pattern ${n}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Icon name="close" />
              </button>
            </div>
            {error && <p data-pattern-error className="mt-1 text-small text-fail">{error}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function RedactionSection({ ctx }: { ctx: RenderCtx }) {
  const globalRows = ctx.config.export.redact.patterns;
  let control: ReactNode;
  if (ctx.surface === 'global') {
    const base = ctx.baseline.export.redact.patterns;
    const set = (patterns: RedactPatternRow[]) => ctx.setConfig({ ...ctx.config, export: { ...ctx.config.export, redact: { patterns } } });
    control = (
      <LayerField<RedactPatternRow[]>
        label="Added patterns"
        value={globalRows}
        inheritedValue={base}
        inherited={JSON.stringify(globalRows) === JSON.stringify(base)}
        dim={false}
        onChange={set}
        onRevert={() => set(base)}
      >
        {({ value, onChange }) => (
          <AddedPatterns rows={value} offset={0} onChange={onChange} serverError={(i) => ctx.errors[`export.redact.patterns.${i}.regex`] ?? ctx.errors[`export.redact.patterns.${i}.id`]} />
        )}
      </LayerField>
    );
  } else {
    const own = ctx.workspace.exportRedactPatterns;
    const set = (patterns: RedactPatternRow[] | null) => ctx.setWorkspace({ ...ctx.workspace, exportRedactPatterns: patterns });
    control = (
      <>
        {globalRows.length > 0 && (
          <ul className="mb-1.5 flex flex-col gap-1.5" aria-label="Global redaction patterns">
            {globalRows.map((row) => (
              <li key={row.id} className="flex items-center gap-2.5 rounded-[3px] border border-dashed border-edge px-2.5 py-1.5">
                <span className="basis-1/3 font-data text-[13px]">{row.id}</span>
                <span className="min-w-0 flex-1 truncate font-data text-small text-muted">{row.regex}</span>
                <span className="rounded-full bg-raised px-2 py-0.5 text-label font-semibold uppercase text-muted">global</span>
              </li>
            ))}
          </ul>
        )}
        <AddedPatterns rows={own ?? []} offset={globalRows.length} onChange={set} serverError={() => ctx.errors.exportRedactPatterns} />
      </>
    );
  }
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <div>
        <h3 className="mb-0.5 text-[13px] font-semibold">Baseline</h3>
        <p className="mb-2.5 text-small text-muted">Built in, always on, read-only.</p>
        <ul className="flex flex-col gap-1.5" aria-label="Baseline redaction patterns">
          {BASELINE_REDACT_PATTERNS.map((p) => (
            <li key={p.id} className="flex min-h-9 items-center gap-2.5 rounded-[3px] border border-hairline bg-sunken px-2.5 py-1.5">
              <span className="min-w-[118px] whitespace-nowrap font-data text-[13px]">{p.id}</span>
              <span className="min-w-0 flex-1 text-small text-muted">{BASELINE_DESCRIPTIONS[p.id] ?? ''}</span>
              <span className="rounded-full bg-raised px-2 py-0.5 text-label font-semibold uppercase text-muted">baseline</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-0.5 text-[13px] font-semibold">Added patterns</h3>
        <p className="mb-2.5 text-small text-muted">Regular expressions matched against the whole Export. Workspace patterns add to these; they can’t remove them.</p>
        {control}
        <div className="mt-3.5 flex items-start gap-2 text-small text-muted">
          <Icon name="alert-triangle" className="mt-0.5 size-3.5" />
          <span>An invalid regular expression is rejected on save and never falls back to an unredacted Export.</span>
        </div>
      </div>
    </div>
  );
}

function AddedPatterns({ rows, offset, onChange, serverError }: { rows: RedactPatternRow[]; offset: number; onChange: (rows: RedactPatternRow[]) => void; serverError: (i: number) => string | undefined }) {
  return (
    <div>
      <PatternRows rows={rows} offset={offset} onChange={onChange} serverError={serverError} />
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        <button type="button" className={btnGhost} onClick={() => onChange([...rows, { id: '', regex: '' }])}>
          + Add pattern
        </button>
        <span className="text-small text-muted">id: lowercase letters, digits, dashes</span>
      </div>
    </div>
  );
}
