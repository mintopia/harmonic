import type { ReactNode } from 'react';
import { displayTitle } from '../ui';
import { Tabs } from './Tabs';
import { SettingsSection } from './SettingsSection';
import { FloatingSaveBar } from './FloatingSaveBar';
import { renderSection, sectionsForTab, type RenderCtx } from './settings-schema';
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
  ctx,
  dirty,
  saving,
  error,
  onSave,
  onDiscard,
  headerActions,
  children,
}: {
  title: string;
  intro: ReactNode;
  tabs: readonly { readonly id: SettingTab; readonly label: string }[];
  tab: SettingTab;
  onTab: (tab: SettingTab) => void;
  ctx: RenderCtx;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  /** Extra out-of-panel content, e.g. the workspace delete confirm dialog. */
  children?: ReactNode;
  headerActions?: ReactNode;
}) {
  const sections = sectionsForTab(ctx.surface, tab);
  const label = ctx.surface === 'workspace' ? 'Workspace settings sections' : 'Settings sections';
  return (
    <div>
      <div className="flex max-w-3xl flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className={displayTitle}>{title}</h1>
          <p className="mt-1 text-muted">{intro}</p>
        </div>
        {headerActions}
      </div>

      <div className="mt-5">
        <Tabs tabs={tabs} active={tab} onChange={(id) => onTab(id as SettingTab)} label={label} />
      </div>

      <div
        id={`settings-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        className="mt-5 grid gap-4 xl:grid-cols-2 xl:items-start"
      >
        {sections.map((section) => {
          const { title: sectionTitle, description, body } = renderSection(section, ctx);
          return (
            <SettingsSection key={`${section.tab}:${sectionTitle}`} title={sectionTitle} description={description}>
              {body}
            </SettingsSection>
          );
        })}
      </div>

      {dirty && <FloatingSaveBar error={error} saving={saving} onDiscard={onDiscard} onSave={onSave} />}

      {children}
    </div>
  );
}
