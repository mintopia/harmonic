import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { PROMPT_ANATOMIES } from '../../../../src/domain/prompt-anatomy.js';
import { btnQuiet } from '../../ui';
import { Icon } from '../Icon';
import type { RenderCtx } from '../settings-schema';
import { AnatomyStack } from './AnatomyStack';
import { CompiledPreviewPane } from './CompiledPreviewPane';
import { PromptIndex } from './PromptIndex';
import {
  anatomyById,
  anatomyCounts,
  conditionsFor,
  firstErroredPart,
  initialState,
  reduce,
  searchParts,
  totals,
} from './prompts-tab-model';
import { useLayoutMode } from './use-layout-mode';
import { assemblePreview, promptSettingsView } from '../../prompt-preview-model';

const STICKY = 'sticky top-0 max-h-[calc(100dvh-4rem)] overflow-y-auto';

export function PromptsTab({ ctx }: { ctx: RenderCtx }) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [previewOpen, setPreviewOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useLayoutMode(rootRef);

  const { config } = ctx;
  const workspace = ctx.surface === 'workspace' ? ctx.workspace : null;
  const view = useMemo(() => promptSettingsView({ config, workspace }), [config, workspace]);
  const anatomy = anatomyById(state.anatomy);
  const conditions = conditionsFor(state, anatomy.id);
  const segments = useMemo(() => assemblePreview(anatomy.id, view, conditions), [anatomy.id, view, conditions]);
  const hits = useMemo(() => searchParts(state.query, view), [state.query, view]);

  const firstError = firstErroredPart(ctx);
  const errorAnatomy = firstError?.anatomy;
  const errorKey = firstError?.key;
  useEffect(() => {
    if (errorAnatomy && errorKey) dispatch({ type: 'jump', anatomy: errorAnatomy, key: errorKey });
  }, [errorAnatomy, errorKey]);

  const items = PROMPT_ANATOMIES.map((a) => ({ anatomy: a, counts: anatomyCounts(a, ctx) }));

  const index = (
    <PromptIndex
      mode={mode}
      items={items}
      totals={totals(ctx)}
      active={anatomy.id}
      query={state.query}
      hits={hits}
      onQuery={(query) => dispatch({ type: 'query', query })}
      onSelect={(id) => dispatch({ type: 'selectAnatomy', anatomy: id })}
      onJump={(a, key) => dispatch({ type: 'jump', anatomy: a, key })}
    />
  );
  const stack = (
    <AnatomyStack
      anatomy={anatomy}
      ctx={ctx}
      expanded={state.expanded}
      conditions={conditions}
      onToggle={(key, occurrence) => dispatch({ type: 'toggle', key, occurrence })}
      onCollapse={() => dispatch({ type: 'collapse' })}
    />
  );
  const preview = (
    <CompiledPreviewPane
      anatomy={anatomy}
      segments={segments}
      expandedKey={state.expanded?.key ?? null}
      conditions={conditions}
      onFlag={(id, on) => dispatch({ type: 'flag', id, on })}
      onChoice={(by, value) => dispatch({ type: 'choice', by, value })}
    />
  );

  return (
    <div ref={rootRef} className="min-w-0">
      {mode === 'wide' && (
        <div className="grid grid-cols-[15rem_minmax(0,1fr)_minmax(20rem,28rem)] rounded-lg bg-surface shadow-card">
          <div className="rounded-l-lg border-r border-hairline bg-shell">
            <div className={`${STICKY} p-3`}>{index}</div>
          </div>
          <div className="min-w-0 p-5">{stack}</div>
          <div className="rounded-r-lg border-l border-hairline bg-sunken">
            <div className={`${STICKY} p-4`}>{preview}</div>
          </div>
        </div>
      )}
      {mode === 'medium' && (
        <div className="rounded-lg bg-surface shadow-card">
          <div className="rounded-t-lg border-b border-hairline bg-shell p-3">{index}</div>
          <div className="grid grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 p-4">{stack}</div>
            <div className="rounded-br-lg border-l border-hairline bg-sunken">
              <div className={`${STICKY} p-3`}>{preview}</div>
            </div>
          </div>
        </div>
      )}
      {mode === 'narrow' && (
        <div className="rounded-lg bg-surface shadow-card">
          <div className="rounded-t-lg border-b border-hairline bg-shell p-3">{index}</div>
          <div className="min-w-0 p-3">{stack}</div>
          <div className="rounded-b-lg border-t border-hairline bg-sunken p-3">
            <button
              type="button"
              aria-expanded={previewOpen}
              aria-controls="prompt-compiled-preview"
              onClick={() => setPreviewOpen((open) => !open)}
              className={`${btnQuiet} gap-1.5`}
            >
              <Icon name="chevron-down" className={`transition-transform motion-reduce:transition-none ${previewOpen ? 'rotate-180' : ''}`} />
              {previewOpen ? 'Hide compiled preview' : 'Show compiled preview'}
            </button>
            <div id="prompt-compiled-preview" hidden={!previewOpen} className="mt-2">
              {previewOpen && preview}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
