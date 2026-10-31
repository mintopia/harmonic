import { useMemo, useState, type ReactNode } from 'react';
import { DndContext, MeasuringStrategy, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { api } from '../../api';
import { useAsyncResource } from '../../useAsyncResource';
import { WORKFLOW_ACTIONS } from '../../../../src/domain/workflow.js';
import { field, labelType, selectField } from '../../ui';
import { messageParts, type WorkflowEditorIssue } from '../../workflow-editor-model';
import {
  addBlock,
  issuesByBlock,
  moveBlock,
  PALETTE,
  pathKey,
  readBuilder,
  removeBlock,
  setAttemptsMax,
  setStepField,
  type BuilderAttempts,
  type BuilderNode,
  type BuilderParallel,
  type BuilderPath,
  type BuilderStep,
  type PaletteItem,
} from '../../workflow-builder-model';

type DragItem = { source: 'palette'; item: PaletteItem } | { source: 'block'; node: BuilderNode };

const HARNESSES = ['claude', 'codex', 'copilot'];
const slotId = (container: BuilderPath, index: number) => `slot|${JSON.stringify(container)}|${index}`;

const kindOf = (item: DragItem): 'step' | 'parallel' | 'attempts' => {
  if (item.source === 'palette') return item.item.kind === 'parallel' ? 'parallel' : item.item.kind === 'attempts' ? 'attempts' : 'step';
  return item.node.kind;
};

function accepts(container: BuilderPath, item: DragItem | null): boolean {
  if (item === null) return false;
  const kind = kindOf(item);
  if (container[container.length - 1] === 'parallel') return kind === 'step';
  if (kind === 'attempts') return container.length === 1 && container[0] === 'steps';
  return true;
}

function inside(container: BuilderPath, item: DragItem | null): boolean {
  if (item === null || item.source !== 'block') return false;
  const from = item.node.path;
  return from.length <= container.length && from.every((k, i) => container[i] === k);
}

function Slot({ container, index, active }: { container: BuilderPath; index: number; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: slotId(container, index) });
  return (
    <div ref={setNodeRef} data-slot={slotId(container, index)} className="relative h-3">
      {active && isOver && <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded bg-accent" />}
    </div>
  );
}

function Grip() {
  return (
    <span aria-hidden className="grid shrink-0 cursor-grab grid-cols-2 gap-0.5 text-faint">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="size-[3px] rounded-full bg-current" />
      ))}
    </span>
  );
}

function Drag({ id, data, children, className, disabled }: { id: string; data: DragItem; children: (grip: ReactNode) => ReactNode; className?: string; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data, disabled });
  return (
    <div ref={setNodeRef} className={`${className ?? ''} ${isDragging ? 'opacity-40' : ''}`}>
      {children(
        <span {...attributes} {...listeners} aria-label="Drag to move" className="inline-flex min-h-6 touch-none items-center">
          <Grip />
        </span>,
      )}
    </div>
  );
}

const TAG_TONE: Record<string, string> = {
  critic: 'bg-ready-tint text-ready',
  merge: 'bg-merged-tint text-merged',
};

function Tag({ text }: { text: string }) {
  return <span className={`shrink-0 rounded-sm px-1.5 py-px font-data text-label font-semibold ${TAG_TONE[text] ?? 'bg-accent-tint text-accent'}`}>{text}</span>;
}

function ErrorText({ issues }: { issues: readonly WorkflowEditorIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="mt-1 text-small text-fail">
      {issues.map((issue, i) => (
        <p key={i} className="m-0">
          Not saved:{' '}
          {messageParts(issue.message).map((part, j) =>
            part.code ? (
              <code key={j} className="rounded-sm bg-raised px-1 font-data text-ink">
                {part.text}
              </code>
            ) : (
              part.text
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mt-3 block">
      <span className={`${labelType} mb-1 block text-muted`}>{label}</span>
      {children}
    </label>
  );
}

function stepDetail(step: BuilderStep): string {
  const parts: string[] = [];
  if (step.prompt !== undefined) parts.push(step.uses === 'critic' ? '' : `prompt ${step.prompt}`);
  if (step.run !== undefined) parts.push(step.run);
  if (step.harness !== undefined) parts.push([step.harness, step.model].filter(Boolean).join(' · '));
  if (step.condition !== undefined) parts.push(`if: ${step.condition}`);
  return parts.filter(Boolean).join('  ');
}

interface Ctx {
  text: string;
  change: (text: string) => void;
  issues: Map<string, WorkflowEditorIssue[]>;
  dragging: DragItem | null;
  prompts: string[];
  selected: string | null;
  select: (key: string | null) => void;
  readOnly: boolean;
}

function Controls({ node, ctx, siblings, index, container }: { node: BuilderNode; ctx: Ctx; siblings: number; index: number; container: BuilderPath }) {
  const btn = 'inline-flex min-h-8 items-center px-1 text-small font-medium text-muted hover:text-ink disabled:opacity-40 disabled:hover:text-muted';
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <button type="button" className={btn} aria-label={`Move ${label(node)} up`} disabled={index === 0} onClick={() => ctx.change(moveBlock(ctx.text, node.path, container, index - 1))}>
        ↑
      </button>
      <button type="button" className={btn} aria-label={`Move ${label(node)} down`} disabled={index >= siblings - 1} onClick={() => ctx.change(moveBlock(ctx.text, node.path, container, index + 2))}>
        ↓
      </button>
      <button type="button" className={btn} aria-label={`Remove ${label(node)}`} onClick={() => ctx.change(removeBlock(ctx.text, node.path))}>
        Remove
      </button>
    </span>
  );
}

const label = (node: BuilderNode): string => (node.kind === 'attempts' ? 'attempts' : node.id);

function StepForm({ step, ctx }: { step: BuilderStep; ctx: Ctx }) {
  const set = (key: Parameters<typeof setStepField>[2], value: string) => ctx.change(setStepField(ctx.text, step.path, key, value));
  const agentLike = step.uses === 'agent' || step.uses === 'critic';
  const isRun = step.run !== undefined && step.uses === undefined;
  const prompts = step.prompt !== undefined && !ctx.prompts.includes(step.prompt) ? [...ctx.prompts, step.prompt] : ctx.prompts;
  const harnesses = step.harness !== undefined && !HARNESSES.includes(step.harness) ? [...HARNESSES, step.harness] : HARNESSES;
  return (
    <div className="mt-2 border-t border-hairline pt-1">
      <Labelled label="Step ID">
        <input disabled={ctx.readOnly} className={field} value={step.id} onChange={(e) => set('id', e.target.value)} />
      </Labelled>
      {isRun ? (
        <Labelled label="Command">
          <input disabled={ctx.readOnly} className={`${field} font-data`} value={step.run ?? ''} onChange={(e) => set('run', e.target.value)} />
        </Labelled>
      ) : (
        <Labelled label="Action">
          <select disabled={ctx.readOnly} className={`${selectField} w-full`} value={step.uses ?? ''} onChange={(e) => set('uses', e.target.value)}>
            {step.uses === undefined && <option value="" />}
            {WORKFLOW_ACTIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </Labelled>
      )}
      {agentLike && (
        <>
          <Labelled label="Harness">
            <select disabled={ctx.readOnly} className={`${selectField} w-full`} value={step.harness ?? ''} onChange={(e) => set('harness', e.target.value)}>
              <option value="">Default</option>
              {harnesses.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Model">
            <input disabled={ctx.readOnly} className={field} value={step.model ?? ''} placeholder="Default" onChange={(e) => set('model', e.target.value)} />
          </Labelled>
          <Labelled label="Prompt (prompt library code)">
            <select disabled={ctx.readOnly} className={`${selectField} w-full`} value={step.prompt ?? ''} onChange={(e) => set('prompt', e.target.value)}>
              <option value="">None</option>
              {prompts.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Labelled>
        </>
      )}
      <Labelled label="Run only if (if:)">
        <input disabled={ctx.readOnly} className={`${field} font-data`} value={step.condition ?? ''} onChange={(e) => set('condition', e.target.value)} />
      </Labelled>
    </div>
  );
}

function StepBlock({ step, ctx, index, siblings, container }: { step: BuilderStep; ctx: Ctx; index: number; siblings: number; container: BuilderPath }) {
  const key = pathKey(step.path);
  const open = ctx.selected === key;
  const errors = ctx.issues.get(key) ?? [];
  const detail = stepDetail(step);
  return (
    <Drag disabled={ctx.readOnly} id={`block|${key}`} data={{ source: 'block', node: step }} className={`rounded-md bg-surface shadow-card ${errors.length > 0 ? 'border border-fail' : open ? 'border border-accent' : 'border border-transparent'} px-3 py-1.5`}>
      {(grip) => (
        <div data-block={key}>
          <div className="flex items-center gap-2">
            {grip}
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} onClick={() => ctx.select(open ? null : key)}>
              <Tag text={step.uses ?? 'run:'} />
              <span className="font-semibold text-ink">{step.id}</span>
              {detail !== '' && <span className="truncate font-data text-small text-muted">{detail}</span>}
            </button>
            {!ctx.readOnly && <Controls node={step} ctx={ctx} siblings={siblings} index={index} container={container} />}
          </div>
          {open && <StepForm step={step} ctx={ctx} />}
          <ErrorText issues={errors} />
        </div>
      )}
    </Drag>
  );
}

function List({ container, nodes, ctx, renderNode }: { container: BuilderPath; nodes: readonly BuilderNode[]; ctx: Ctx; renderNode: (n: BuilderNode, i: number) => ReactNode }) {
  const active = !ctx.readOnly && accepts(container, ctx.dragging) && !inside(container, ctx.dragging);
  return (
    <div>
      {nodes.map((node, i) => (
        <div key={pathKey(node.path)}>
          <Slot container={container} index={i} active={active} />
          {renderNode(node, i)}
        </div>
      ))}
      <Slot container={container} index={nodes.length} active={active} />
    </div>
  );
}

function ParallelBlock({ group, ctx, index, siblings, container }: { group: BuilderParallel; ctx: Ctx; index: number; siblings: number; container: BuilderPath }) {
  const key = pathKey(group.path);
  const errors = ctx.issues.get(key) ?? [];
  const open = ctx.selected === key;
  const set = (value: string) => ctx.change(setStepField(ctx.text, group.path, 'condition', value));
  return (
    <Drag disabled={ctx.readOnly} id={`block|${key}`} data={{ source: 'block', node: group }} className={`rounded-md bg-sunken px-2 py-1.5 ${errors.length > 0 ? 'border border-fail' : 'border border-transparent'}`}>
      {(grip) => (
        <div data-block={key}>
          <div className="flex items-center gap-2">
            {grip}
            <button type="button" className="flex flex-1 items-center gap-2 text-left" aria-expanded={open} onClick={() => ctx.select(open ? null : key)}>
              <span className={`${labelType} text-muted`}>Parallel</span>
              <span className="font-data text-small text-muted">{group.id}</span>
              {group.condition !== undefined && <span className="font-data text-small font-semibold text-ink">◇ if: {group.condition}</span>}
            </button>
            {!ctx.readOnly && <Controls node={group} ctx={ctx} siblings={siblings} index={index} container={container} />}
          </div>
          {open && (
            <div className="px-1 pb-1">
              <Labelled label="Run only if (if:)">
                <input disabled={ctx.readOnly} className={`${field} font-data`} value={group.condition ?? ''} onChange={(e) => set(e.target.value)} />
              </Labelled>
            </div>
          )}
          <ErrorText issues={errors} />
          <List container={[...group.path, 'parallel']} nodes={group.children} ctx={ctx} renderNode={(n, i) => <StepBlock step={n as BuilderStep} ctx={ctx} index={i} siblings={group.children.length} container={[...group.path, 'parallel']} />} />
        </div>
      )}
    </Drag>
  );
}

function AttemptsBlock({ block, ctx, index, siblings, container }: { block: BuilderAttempts; ctx: Ctx; index: number; siblings: number; container: BuilderPath }) {
  const key = pathKey(block.path);
  const errors = ctx.issues.get(key) ?? [];
  const inner = [...block.path, 'attempts', 'steps'];
  return (
    <Drag disabled={ctx.readOnly} id={`block|${key}`} data={{ source: 'block', node: block }} className={`rounded-md border border-dashed px-2 py-1.5 ${errors.length > 0 ? 'border-fail' : 'border-accent'}`}>
      {(grip) => (
        <div data-block={key}>
          <div className="flex items-center gap-2">
            {grip}
            <span className={`${labelType} ${errors.length > 0 ? 'text-fail' : 'text-accent'}`}>Attempts</span>
            <span className="flex-1" />
            <label className="flex items-center gap-2 text-small text-muted">
              max
              <input aria-label="Attempts max" disabled={ctx.readOnly} className={`${field} w-44 font-data ${errors.length > 0 ? 'border-fail' : ''}`} value={block.max} onChange={(e) => ctx.change(setAttemptsMax(ctx.text, block.path, e.target.value))} />
            </label>
            {!ctx.readOnly && <Controls node={block} ctx={ctx} siblings={siblings} index={index} container={container} />}
          </div>
          <ErrorText issues={errors} />
          <List
            container={inner}
            nodes={block.children}
            ctx={ctx}
            renderNode={(n, i) =>
              n.kind === 'parallel' ? <ParallelBlock group={n} ctx={ctx} index={i} siblings={block.children.length} container={inner} /> : <StepBlock step={n as BuilderStep} ctx={ctx} index={i} siblings={block.children.length} container={inner} />
            }
          />
        </div>
      )}
    </Drag>
  );
}

function PaletteChip({ item, label }: { item: PaletteItem; label: string }) {
  const id = `palette|${label}`;
  const { attributes, listeners, setNodeRef } = useDraggable({ id, data: { source: 'palette', item } satisfies DragItem });
  return (
    <button type="button" ref={setNodeRef} {...attributes} {...listeners} data-palette={label} className="inline-flex min-h-9 touch-none items-center gap-1.5 rounded-md border border-edge bg-surface px-2 py-1 text-small hover:border-accent">
      <Grip />
      <span className="font-data font-semibold text-ink">{label}</span>
      <span className="text-label text-muted">{item.hint}</span>
    </button>
  );
}

function Palette() {
  return (
    <div className="rounded-lg bg-surface px-3.5 py-2.5 shadow-card">
      {PALETTE.map((group) => (
        <div key={group.title} className="mb-2 last:mb-0">
          <p className={`${labelType} mb-1.5 text-muted`}>{group.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {group.items.map((entry) => (
              <PaletteChip key={entry.label} item={entry} label={entry.label} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function WorkflowBuilder({ text, issues, dirty, readOnly, onChange }: { text: string; issues: readonly WorkflowEditorIssue[]; dirty: boolean; readOnly: boolean; onChange: (text: string) => void }) {
  const tree = useMemo(() => readBuilder(text), [text]);
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const prompts = useAsyncResource(() => api.prompts(), []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const grouped = useMemo(() => (tree === null ? new Map<string, WorkflowEditorIssue[]>() : issuesByBlock(tree, issues)), [tree, issues]);

  const ctx: Ctx = { text, change: onChange, issues: grouped, dragging, prompts: (prompts.data?.prompts ?? []).map((p) => p.code), selected, select: setSelected, readOnly };

  const onDragStart = (event: DragStartEvent) => setDragging((event.active.data.current as DragItem | undefined) ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const item = event.active.data.current as DragItem | undefined;
    const over = typeof event.over?.id === 'string' ? event.over.id : null;
    if (!item || over === null || !over.startsWith('slot|')) return;
    const [, container, index] = over.split('|') as [string, string, string];
    const path = JSON.parse(container) as BuilderPath;
    if (!accepts(path, item) || inside(path, item)) return;
    onChange(item.source === 'palette' ? addBlock(text, path, Number(index), item.item) : moveBlock(text, item.node.path, path, Number(index)));
  };

  const status = tree === null ? 'YAML has errors; fix them to edit blocks' : dirty ? 'In sync with YAML · 1 unsaved change' : 'In sync with YAML';
  const canvas = tree === null ? null : (
    <div className="rounded-lg bg-sunken p-2.5">
      <List
        container={['steps']}
        nodes={tree.steps}
        ctx={ctx}
        renderNode={(n, i) =>
          n.kind === 'attempts' ? <AttemptsBlock block={n} ctx={ctx} index={i} siblings={tree.steps.length} container={['steps']} /> : <StepBlock step={n as BuilderStep} ctx={ctx} index={i} siblings={tree.steps.length} container={['steps']} />
        }
      />
      {tree.cleanup.length > 0 && (
        <>
          <p className={`${labelType} mt-2 text-muted`}>Cleanup</p>
          <List
            container={['cleanup']}
            nodes={tree.cleanup}
            ctx={ctx}
            renderNode={(n, i) => (n.kind === 'parallel' ? <ParallelBlock group={n} ctx={ctx} index={i} siblings={tree.cleanup.length} container={['cleanup']} /> : <StepBlock step={n as BuilderStep} ctx={ctx} index={i} siblings={tree.cleanup.length} container={['cleanup']} />)}
          />
        </>
      )}
    </div>
  );

  return (
    <section aria-label="Workflow builder" className="px-3.5 pb-3">
      <DndContext measuring={{ droppable: { strategy: MeasuringStrategy.Always } }} sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        {!readOnly && <Palette />}
        <p className="my-2 flex items-center gap-2 text-small text-muted">
          <span className={`size-2 rounded-full ${tree === null ? 'bg-fail-dot' : 'bg-done-dot'}`} />
          {status}
        </p>
        {canvas}
      </DndContext>
      <p className="mt-3 flex items-center gap-2 text-small text-muted">
        <span className="size-2 rounded-full bg-done-dot" />
        YAML (edits here update the blocks)
      </p>
    </section>
  );
}
