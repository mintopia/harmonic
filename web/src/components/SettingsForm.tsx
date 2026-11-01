import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { ExportDeliveryState } from '../types';
import { PageHeader } from './PageHeader';
import { Tabs, panelId, tabId } from './Tabs';
import { SettingsSection } from './SettingsSection';
import { FloatingSaveBar } from './FloatingSaveBar';
import { StepRail, stepPanelId } from './StepRail';
import { ResolutionStrip } from './ResolutionStrip';
import { promptsRailState, useOptionalPromptsFlow } from './prompt-library/PromptsFlow';
import { btnGhost } from '../ui';
import { BREADCRUMB_INCLUDES_STEP, TAB_RAIL_TITLES, resolveStep } from '../settings-steps-model';
import { renderSection, sectionAnchor, sectionsForStep, stepStrip, stepValue, stepsForSurface, type RenderCtx } from './settings-schema';
import type { SettingTab } from '../../../src/domain/settings-registry.js';

const MONO_VALUE_STEPS: ReadonlySet<string> = new Set(['find']);

/**
 * The single settings renderer. The global and per-Workspace
 * surfaces are the *same* engine over the *same* {@link SETTINGS_SCHEMA}: this
 * component owns the header, the tab strip, the tabbed section panel, and the
 * buffered save bar. Each surface passes its own tab strip, its render context
 * (`ctx.surface` selects the global config binding or the workspace inherit
 * layer), and its dirty/save plumbing — the transport differs (whole-config PUT
 * vs field PATCH) but the interaction is identical.
 */
export function SettingsForm({
  title,
  intro,
  tabs,
  tab,
  onTab,
  step,
  onStep,
  ctx,
  dirty,
  saving,
  error,
  onSave,
  saveDisabled,
  onDiscard,
  headerActions,
  children,
}: {
  title: string;
  intro: ReactNode;
  tabs: readonly { readonly id: SettingTab; readonly label: string }[];
  tab: SettingTab;
  onTab: (tab: SettingTab) => void;
  step: string | null;
  onStep: (step: string) => void;
  ctx: RenderCtx;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  saveDisabled?: boolean;
  onDiscard: () => void;
  /** Extra out-of-panel content, e.g. the workspace delete confirm dialog. */
  children?: ReactNode;
  headerActions?: ReactNode;
}) {
  const [deliveries, setDeliveries] = useState<ExportDeliveryState | undefined>(undefined);
  useEffect(() => {
    if (tab !== 'archive') return;
    let live = true;
    api.exportDestinations().then((d) => live && setDeliveries(d), () => undefined);
    return () => {
      live = false;
    };
  }, [tab]);
  const steps = stepsForSurface(ctx.surface, tab);
  const flow = useOptionalPromptsFlow();
  const promptsRail = tab === 'prompts' ? promptsRailState(flow) : null;
  const disabledSet = promptsRail?.disabled;
  const current = resolveStep(steps, step && disabledSet?.has(step) ? null : step);
  const sections = sectionsForStep(ctx.surface, tab, current);
  const strip = stepStrip({ ...ctx, deliveries }, tab, current);
  const index = steps.findIndex((s) => s.id === current);
  const currentStep = steps[index];
  const previous = steps[index - 1];
  const next = steps.slice(index + 1).find((s) => !disabledSet?.has(s.id));
  const tabLabel = tabs.find((t) => t.id === tab)?.label ?? '';
  const promptCrumbs = tab === 'prompts' && flow && current !== 'find' ? ['All prompts', flow.isNew ? 'New prompt' : (flow.selected ?? '')] : [];
  const crumbs = ['Settings', tabLabel, ...(BREADCRUMB_INCLUDES_STEP.has(tab) && currentStep ? [currentStep.title] : []), ...promptCrumbs].join(' › ');
  const label = ctx.surface === 'workspace' ? 'Workspace settings sections' : 'Settings sections';
  const railLabel = TAB_RAIL_TITLES[tab];
  const values = promptsRail?.values ?? Object.fromEntries(steps.map((s) => [s.id, stepValue(ctx, tab, s.id)]));
  const jump = (id: string) => onStep(id);
  return (
    <div>
      <PageHeader title={title} description={intro} actions={headerActions} fill />

      <div>
        <Tabs tabs={tabs} active={tab} onChange={(id) => onTab(id as SettingTab)} label={label} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="rounded-full bg-raised px-2 py-0.5 text-badge font-bold uppercase text-muted">
          {ctx.surface === 'workspace' ? 'Workspace' : 'Global'}
        </span>
        <span className="text-small text-muted">{crumbs}</span>
      </div>

      <div
        id={panelId(tab)}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
        className="mt-5 flex min-w-0 flex-col gap-6 md:flex-row md:items-start"
      >
        <StepRail steps={steps} current={current} onSelect={jump} label={railLabel}
          values={values}
          summaries={promptsRail?.summaries}
          disabled={disabledSet}
          monoValueSteps={promptsRail ? MONO_VALUE_STEPS : undefined}
        />

        <div id={stepPanelId(current)} className="flex min-w-0 flex-1 flex-col gap-4">
          {currentStep && !currentStep.ownHeader && (
            <div className="flex flex-col gap-1.5">
              <h2 className="text-display font-semibold">{currentStep.heading}</h2>
              <p className="text-body text-muted">{currentStep.intro}</p>
            </div>
          )}
          {strip && <ResolutionStrip label={strip.label} rules={strip.rules} onStep={jump} />}
          {sections.map((section, sectionIndex) => {
            const { title: sectionTitle, titleChip, description, body, action } = renderSection(section, { ...ctx, dirty, onTab, onStep: jump, deliveries });
            const anchor = sectionAnchor(sectionTitle);
            const divider = section.divider && !sections.slice(0, sectionIndex).some((earlier) => earlier.divider === section.divider) ? section.divider : null;
            const card = section.bare ? (
              <div id={anchor} className="min-w-0">
                {body}
              </div>
            ) : (
              <SettingsSection id={anchor} title={sectionTitle} titleChip={titleChip} ordinal={section.ordinal} leading={section.leading} description={description} action={action}>
                {body}
              </SettingsSection>
            );
            return (
              <Fragment key={`${section.tab}:${sectionTitle}`}>
                {divider && (
                  <div className="mt-2 flex items-center gap-3">
                    <span className="text-micro font-bold uppercase tracking-wider text-ink">{divider}</span>
                    <span className="h-px flex-1 bg-edge" />
                  </div>
                )}
                {card}
              </Fragment>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex flex-wrap items-center gap-3">
              {previous && (
                <button type="button" className={btnGhost} onClick={() => jump(previous.id)}>
                  ← {currentStep?.backTitle ?? previous.title}
                </button>
              )}
              {currentStep?.note && <span className="text-small text-muted">{currentStep.note}</span>}
            </div>
            {next && (
              <button type="button" className={btnGhost} onClick={() => jump(next.id)}>
                Next: {next.nextTitle ?? next.title} →
              </button>
            )}
          </div>
        </div>
      </div>

      {dirty && <FloatingSaveBar error={error} saving={saving} onDiscard={onDiscard} onSave={onSave} saveDisabled={saveDisabled} />}

      {children}
    </div>
  );
}
