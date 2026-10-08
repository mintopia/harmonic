import type { ReactNode } from 'react';
import type { PartKey, PromptAnatomy } from '../../../../src/domain/prompt-anatomy.js';
import type { RenderCtx } from '../settings-schema';
import { PartCard, Tag } from './PartCard';
import { anatomyLayout, type ExpandedPart, type LayoutNode } from './prompts-tab-model';
import type { SampleConditions } from '../../prompt-preview-model';

export const ANATOMY_PANEL_ID = 'prompt-anatomy-panel';
export const anatomyTabId = (id: string): string => `prompt-anatomy-tab-${id}`;

export function AnatomyStack({
  anatomy,
  ctx,
  expanded,
  conditions,
  onToggle,
  onCollapse,
}: {
  anatomy: PromptAnatomy;
  ctx: RenderCtx;
  expanded: ExpandedPart | null;
  conditions: SampleConditions;
  onToggle: (key: PartKey, occurrence: number) => void;
  onCollapse: () => void;
}) {
  const layout = anatomyLayout(anatomy);

  const renderNode = (node: LayoutNode, parentKey: PartKey | null): ReactNode => {
    if (node.kind === 'oneOf') {
      const { choice } = node;
      const selected = conditions.choices[choice.by] ?? anatomy.selectorDefaults[choice.by];
      return (
        <div role="group" aria-label={choice.label} className="rounded-lg border border-dashed border-edge p-2.5">
          <p className="mb-2 text-small text-faint">{choice.label}</p>
          <div className="flex flex-col gap-3">
            {node.options.map(({ option, nodes }) => (
              <div key={option.value} className="flex flex-col gap-2">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small">
                  <span className="font-semibold text-ink">{option.label}</span>
                  <span className="text-faint">{option.when}</span>
                  {option.value === selected && <Tag tone="accent">In preview</Tag>}
                </p>
                {nodes.map((child, i) => (
                  <div key={child.kind === 'part' ? `${child.part.key}:${child.occurrence}` : `oneOf:${i}`}>{renderNode(child, parentKey)}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }
    const { part } = node;
    const flag = part.when === undefined ? undefined : anatomy.flags.find((f) => f.id === part.when);
    const open = expanded !== null && expanded.key === part.key && expanded.occurrence === node.occurrence;
    return (
      <PartCard
        part={part}
        ctx={ctx}
        flag={flag}
        parentKey={parentKey}
        open={open}
        onToggle={() => onToggle(part.key, node.occurrence)}
        onCollapse={onCollapse}
      >
        {node.nested.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-2 border-l border-hairline pl-3">
            {node.nested.map((child, i) => (
              <div key={child.kind === 'part' ? `${child.part.key}:${child.occurrence}` : `oneOf:${i}`}>{renderNode(child, part.key)}</div>
            ))}
          </div>
        )}
      </PartCard>
    );
  };

  return (
    <div role="tabpanel" id={ANATOMY_PANEL_ID} aria-labelledby={anatomyTabId(anatomy.id)} className="min-w-0">
      <h3 className="text-title font-semibold text-ink">{anatomy.title}</h3>
      <p className="mb-4 mt-0.5 max-w-prose text-muted">{anatomy.description} Dashed parts are included only when their condition holds.</p>
      <ol className="m-0 list-none p-0">
        {layout.steps.map(({ step, node }) => {
          const conditional = node.kind === 'part' && node.part.when !== undefined;
          return (
            <li
              key={step}
              className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5 pb-3 before:absolute before:bottom-0 before:left-[0.8125rem] before:top-[2.125rem] before:border-l before:border-edge last:pb-0 last:before:hidden"
            >
              <span
                aria-hidden="true"
                className={`relative z-[1] mt-2.5 grid size-6 place-items-center rounded-full text-small tabular-nums ${
                  conditional ? 'border border-dashed border-edge-strong text-faint' : 'bg-raised text-muted'
                }`}
              >
                {step}
              </span>
              <div className="min-w-0">{renderNode(node, null)}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
