import type { ReactNode } from 'react';
import { PageHeader } from './PageHeader';
import { Tabs, panelId, tabId } from './Tabs';
import { SettingsSection } from './SettingsSection';
import { FloatingSaveBar } from './FloatingSaveBar';
import { StepRail, stepPanelId } from './StepRail';
import { ResolutionStrip } from './ResolutionStrip';
import { btnGhost } from '../ui';
import { BREADCRUMB_INCLUDES_STEP, TAB_RAIL_TITLES, resolveStep } from '../settings-steps-model';
import { renderSection, sectionAnchor, sectionsForStep, stepStrip, stepValue, stepsForSurface, type RenderCtx } from './settings-schema';
import type { SettingTab } from '../../../src/domain/settings-registry.js';

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
  const steps = stepsForSurface(ctx.surface, tab);
  const current = resolveStep(steps, step);
  const sections = sectionsForStep(ctx.surface, tab, current);
  const strip = stepStrip(ctx, tab, current);
  const index = steps.findIndex((s) => s.id === current);
  const currentStep = steps[index];
  const previous = steps[index - 1];
  const next = steps[index + 1];
  const tabLabel = tabs.find((t) => t.id === tab)?.label ?? '';
  const crumbs = ['Settings', tabLabel, ...(BREADCRUMB_INCLUDES_STEP.has(tab) && currentStep ? [currentStep.title] : [])].join(' › ');
  const label = ctx.surface === 'workspace' ? 'Workspace settings sections' : 'Settings sections';
  const railLabel = TAB_RAIL_TITLES[tab];
  const values = Object.fromEntries(steps.map((s) => [s.id, stepValue(ctx, tab, s.id)]));
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
        <StepRail steps={steps} current={current} onSelect={jump} label={railLabel} values={values} />

        <div id={stepPanelId(current)} className="flex min-w-0 flex-1 flex-col gap-4">
          {currentStep && (
            <div className="flex flex-col gap-1.5">
              <h2 className="text-display font-semibold">{currentStep.heading}</h2>
              <p className="text-body text-muted">{currentStep.intro}</p>
            </div>
          )}
          {strip && <ResolutionStrip label={strip.label} rules={strip.rules} />}
          {sections.map((section) => {
            const { title: sectionTitle, description, body, action } = renderSection(section, { ...ctx, dirty, onTab });
            const anchor = sectionAnchor(sectionTitle);
            if (section.bare) {
              return (
                <div key={`${section.tab}:${sectionTitle}`} id={anchor} className="min-w-0">
                  {body}
                </div>
              );
            }
            return (
              <SettingsSection key={`${section.tab}:${sectionTitle}`} id={anchor} title={sectionTitle} description={description} action={action}>
                {body}
              </SettingsSection>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex flex-wrap items-center gap-3">
              {previous && (
                <button type="button" className={btnGhost} onClick={() => jump(previous.id)}>
                  ← {previous.title}
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
