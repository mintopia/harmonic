import type { ReactNode } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { describeWorkflowLabelIssue, workflowLabelIssueMessage, workflowLabelIssues, workflowLabelOverlayIssues, workflowLabelRef, type WorkflowLabelIssue } from '../../../src/domain/setting-override.js';
import { BUNDLED_EPIC_WORKFLOW } from '../../../src/domain/workflow.js';
import { api } from '../api';
import type { AppConfig, WorkflowLabelOverlayEntry, WorkflowLibraryEntry } from '../types';
import { chip, codeChip, field } from '../ui';
import { useAsyncResource } from '../useAsyncResource';
import {
  Precedence,
  RemoveButton,
  RoutingListFrame,
  RoutingRowShell,
  arrowCell,
  stackedCell,
  trailingCell,
  workflowCellsGrid,
} from './RoutingLabelsEditor';
import { fieldLabel } from './SettingsSection';
import { Switch } from './Switch';
import { isIssueVisible, issuesByIndex } from './routing-label-overlay-model';
import { WORKFLOW_LABEL, newLocalWorkflowEntry, versionSuffix, workflowOptions, workflowOverlayRows } from './workflow-label-model';

type WorkflowLabel = AppConfig['workflowLabels'][number];

const STEPS = ['Operator choice on the Ticket', WORKFLOW_LABEL, 'Workspace default', 'Global default'];
const compactSelect = 'hm-select min-h-9 w-full rounded-md border border-edge bg-field px-2.5 py-1 text-ink focus:border-accent focus:outline-none';
const compactField = `${field} min-h-9 py-1 font-data text-data`;
const globalChip = `${chip} bg-raised text-muted`;

function useWorkflowLibrary(): WorkflowLibraryEntry[] {
  return useAsyncResource(() => api.workflows(), []).data?.workflows ?? [];
}

function WorkflowSelect({
  library,
  value,
  label,
  className,
  onChange,
}: {
  library: readonly WorkflowLibraryEntry[];
  value: string;
  label: string;
  className?: string;
  onChange: (workflow: string) => void;
}) {
  return (
    <select aria-label={label} className={`${compactSelect} ${className ?? ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {value === '' && <option value="">Choose a workflow</option>}
      {workflowOptions(library, value).map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

function WorkflowCells({
  index,
  item,
  library,
  invalid,
  onChange,
  onTouched,
}: {
  index: number;
  item: WorkflowLabel;
  library: readonly WorkflowLibraryEntry[];
  invalid: boolean;
  onChange: (item: WorkflowLabel) => void;
  onTouched: () => void;
}) {
  const n = index + 1;
  return (
    <>
      <input
        aria-label={`${WORKFLOW_LABEL} ${n}`}
        aria-invalid={invalid}
        className={`${compactField} ${invalid ? 'border-fail focus:border-fail' : ''}`}
        value={item.label}
        onChange={(e) => onChange({ ...item, label: e.target.value })}
        onBlur={onTouched}
      />
      {arrowCell}
      <WorkflowSelect library={library} value={item.workflow} label={`Workflow for ${WORKFLOW_LABEL} ${n}`} className={stackedCell} onChange={(workflow) => onChange({ ...item, workflow })} />
    </>
  );
}

function ErrorText({ issue, label }: { issue: WorkflowLabelIssue; label: string }) {
  const { before, globalRef, after } = describeWorkflowLabelIssue(issue, label);
  return (
    <>
      {before}
      {globalRef !== undefined && <code className={codeChip}>{globalRef}</code>}
      {after}
    </>
  );
}

function DefaultWorkflow({
  id,
  label,
  note,
  library,
  value,
  inheritLabel,
  subject = 'ticket',
  bare = false,
  onChange,
}: {
  id: string;
  label: string;
  note: ReactNode;
  library: readonly WorkflowLibraryEntry[];
  value: string | null;
  inheritLabel?: string;
  subject?: 'ticket' | 'epic';
  bare?: boolean;
  onChange: (workflow: string | null) => void;
}) {
  return (
    <div className={bare ? '' : 'mt-5 border-t border-hairline pt-4'}>
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <select id={id} className={`${compactSelect} ${bare ? 'sm:max-w-[360px]' : 'sm:max-w-sm'}`} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
        <option value="">{inheritLabel ?? 'None · today’s path'}</option>
        {workflowOptions(library, value ?? '', subject).map((name) => (
          <option key={name} value={name}>
            {name}
            {versionSuffix(library, name)}
          </option>
        ))}
      </select>
      <p className="mt-2 text-small text-faint">{note}</p>
    </div>
  );
}

export function EpicWorkflowEditor({
  surface,
  value,
  globalValue,
  onChange,
}: {
  surface: 'global' | 'workspace';
  value: string | null;
  globalValue: string | null;
  onChange: (workflow: string | null) => void;
}) {
  const library = useWorkflowLibrary();
  const workspace = surface === 'workspace';
  return (
    <DefaultWorkflow
      bare
      subject="epic"
      id={workspace ? 'workspace-epic-workflow' : 'settings-epic-workflow'}
      label="Epic workflow"
      note={
        workspace
          ? <>Lists Epic workflows only (<code className={codeChip}>subject: epic</code>). Applies from the next Epic verification.</>
          : 'Used when the Workspace has no Epic workflow of its own.'
      }
      library={library}
      value={value}
      inheritLabel={workspace ? `Use global default · ${globalValue ?? BUNDLED_EPIC_WORKFLOW}` : `Bundled default · ${BUNDLED_EPIC_WORKFLOW}${versionSuffix(library, BUNDLED_EPIC_WORKFLOW)}`}
      onChange={onChange}
    />
  );
}

function RoutingCrossReference() {
  const go = () => {
    const heading = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === 'Routing Labels');
    heading?.scrollIntoView({ block: 'start' });
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-dashed border-hairline bg-sunken px-3.5 py-2.5 text-small text-muted">
      <span className="font-semibold text-ink">Routing Labels</span>
      <span className="min-w-0 flex-1">A separate list further down this page. Routing Labels pick a Harness and Model; Workflow Labels pick a workflow. A Ticket can match one of each.</span>
      <button type="button" className="font-semibold text-accent hover:text-accent-hot" onClick={go}>
        Go to Routing Labels
      </button>
    </div>
  );
}

const CUTOVER = 'Until the cutover from ADR-0055 a Ticket with no resolved workflow stays on today’s path.';

export function WorkflowLabelsEditor({ config, onChange }: { config: AppConfig; onChange: (config: AppConfig) => void }) {
  const library = useWorkflowLibrary();
  const items = config.workflowLabels;
  const issues = issuesByIndex(workflowLabelIssues(items));
  const set = (workflowLabels: WorkflowLabel[]) => onChange({ ...config, workflowLabels });
  return (
    <div>
      <Precedence steps={STEPS} accent={WORKFLOW_LABEL} />
      <RoutingListFrame
        noun={WORKFLOW_LABEL}
        count={items.length}
        onMove={(from, to) => set(arrayMove(items, from, to))}
        onAdd={() => set([...items, { label: '', workflow: workflowOptions(library, '')[0] ?? '' }])}
        onRemove={(index) => set(items.filter((_, i) => i !== index))}
        emptyText="No Workflow Labels. A Ticket uses the Workspace or Global default workflow."
        renderRow={({ id, index, touched, touch, remove }) => {
          const item = items[index];
          if (!item) return null;
          const issue = issues.get(index);
          const visible = isIssueVisible(issue, touched) ? issue : null;
          return (
            <RoutingRowShell id={id} index={index} noun={WORKFLOW_LABEL} grid={workflowCellsGrid} error={visible && workflowLabelIssueMessage(visible, item.label)}>
              <WorkflowCells index={index} item={item} library={library} invalid={visible !== null} onChange={(next) => set(items.map((c, i) => (i === index ? next : c)))} onTouched={touch} />
              <RemoveButton index={index} noun={WORKFLOW_LABEL} onRemove={remove} />
            </RoutingRowShell>
          );
        }}
      />
      <DefaultWorkflow
        id="settings-workflow"
        label="Global default workflow"
        note="Used when no Workflow Label matches and the Workspace has no default."
        library={library}
        value={config.defaults.workflow}
        onChange={(workflow) => onChange({ ...config, defaults: { ...config.defaults, workflow } })}
      />
      <RoutingCrossReference />
    </div>
  );
}

export function WorkflowLabelOverlayEditor({
  overlay,
  workflow,
  config,
  onChange,
  onWorkflow,
}: {
  overlay: WorkflowLabelOverlayEntry[] | null;
  workflow: string | null;
  config: AppConfig;
  onChange: (overlay: WorkflowLabelOverlayEntry[]) => void;
  onWorkflow: (workflow: string | null) => void;
}) {
  const library = useWorkflowLibrary();
  const globals = config.workflowLabels;
  const globalByRef = new Map(globals.map((g) => [workflowLabelRef(g), g]));
  const rows = workflowOverlayRows(overlay, globals);
  const issues = issuesByIndex(workflowLabelOverlayIssues(rows, globals));
  const set = (index: number, next: WorkflowLabelOverlayEntry) => onChange(rows.map((row, i) => (i === index ? next : row)));
  const globalDefault = config.defaults.workflow;
  return (
    <div>
      <RoutingListFrame
        noun={WORKFLOW_LABEL}
        count={rows.length}
        onMove={(from, to) => onChange(arrayMove(rows, from, to))}
        onAdd={() => onChange([...rows, newLocalWorkflowEntry(workflowOptions(library, '')[0] ?? '')])}
        onRemove={(index) => onChange(rows.filter((_, i) => i !== index))}
        emptyText="No Workflow Labels. A Ticket uses the Workspace or Global default workflow."
        renderRow={({ id, index, touched, touch, remove }) => {
          const entry = rows[index];
          if (!entry) return null;
          const n = index + 1;
          if (entry.kind === 'local') {
            const issue = issues.get(index);
            const visible = isIssueVisible(issue, touched) ? issue : null;
            return (
              <RoutingRowShell id={id} index={index} noun={WORKFLOW_LABEL} grid={workflowCellsGrid} error={visible && <ErrorText issue={visible} label={entry.workflowLabel.label} />}>
                <WorkflowCells index={index} item={entry.workflowLabel} library={library} invalid={visible !== null} onChange={(workflowLabel) => set(index, { ...entry, workflowLabel })} onTouched={touch} />
                <RemoveButton index={index} noun={WORKFLOW_LABEL} onRemove={remove} />
              </RoutingRowShell>
            );
          }
          const global = globalByRef.get(entry.ref);
          const dim = entry.enabled ? '' : 'opacity-55 line-through';
          return (
            <RoutingRowShell id={id} index={index} noun={WORKFLOW_LABEL} grid={workflowCellsGrid} locked>
              <span title={global?.label} className={`min-w-0 truncate font-data text-data ${global ? 'text-ink' : 'italic text-faint line-through'} ${dim}`}>
                {global ? global.label : entry.ref}
              </span>
              {arrowCell}
              {global ? (
                <span className={`${stackedCell} min-w-0 truncate text-ink ${dim}`}>{global.workflow}</span>
              ) : (
                <span className="col-span-2 col-start-3 text-small italic text-faint @[44rem]:col-start-auto">Removed: this global label no longer exists.</span>
              )}
              <span className={`flex items-center justify-end gap-2 ${trailingCell}`}>
                {global ? (
                  <>
                    <span className={globalChip}>Global</span>
                    <Switch checked={entry.enabled} onChange={(enabled) => set(index, { ...entry, enabled })} label={entry.enabled ? `Disable workflow label ${n}` : `Enable workflow label ${n}`} />
                  </>
                ) : (
                  <RemoveButton index={index} noun={WORKFLOW_LABEL} onRemove={remove} />
                )}
              </span>
            </RoutingRowShell>
          );
        }}
      />
      <DefaultWorkflow
        id="workspace-workflow"
        label="Workspace default workflow"
        note={CUTOVER}
        library={library}
        value={workflow}
        inheritLabel={`Use global default · ${globalDefault ?? 'none'}`}
        onChange={onWorkflow}
      />
    </div>
  );
}
