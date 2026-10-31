import { useState } from 'react';
import { api } from '../api';
import { errorText } from '../error-text';
import { daysAgo, proxyCheckPanel, rotateKeyCopy, rotatedSummary } from '../execution-targets-model';
import type { ExecutionTarget, ProxyKeyCheck, ProxyKeyRotation } from '../types';
import { btnDestructive, btnGhost, btnQuiet, statePillShape } from '../ui';
import { useCopyConfirmation } from './CopyButton';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { Parts } from './execution-target-parts';

const codeInline = 'rounded-sm bg-sunken px-1.5 font-data text-small';
const chip = 'rounded-full bg-raised px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] text-muted';
const factLabel = 'mb-1 text-[10px] font-bold uppercase tracking-[0.07em] text-faint';

export function RepositoryProxyKey({ target, onRotated }: { target: ExecutionTarget; onRotated: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotation, setRotation] = useState<ProxyKeyRotation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ProxyKeyCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const { copied, copy: copyKey } = useCopyConfirmation();
  const [now] = useState(() => Date.now());
  const key = target.proxyKey;
  const copy = rotateKeyCopy(target.name, target.running);

  const rotate = () => {
    setRotating(true);
    setError(null);
    api.rotateExecutionTargetProxyKey(target.name).then(
      (result) => {
        setRotation(result);
        setConfirming(false);
        onRotated();
      },
      (e) => setError(errorText(e)),
    ).finally(() => setRotating(false));
  };

  const runCheck = () => {
    setChecking(true);
    api.checkExecutionTargetProxyKey(target.name).then(
      (result) => setCheck(result.outcome),
      (e) => setError(errorText(e)),
    ).finally(() => setChecking(false));
  };

  const panel = check ? proxyCheckPanel(check) : null;

  return (
    <div className="pb-[18px]">
      <p className="mb-3 text-muted">Pods never hold the Code Repository&apos;s credentials. The proxy does, and lets a pod through only with a pass Harmonic signed.</p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-hairline bg-sunken px-3 py-2">
          <div className={factLabel}>Signing key</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${statePillShape} gap-1.5 ${key?.set ? 'bg-merged-tint text-merged' : 'bg-raised text-muted'}`}>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              {key?.set ? 'set' : 'not set'}
            </span>
            <code className={codeInline}>{key?.secretName}</code>
          </div>
        </div>
        <div className="rounded-md border border-hairline bg-sunken px-3 py-2">
          <div className={factLabel}>Last rotated</div>
          <div className="text-[13px] font-semibold">
            {key?.rotatedAt ? (
              <>
                {new Date(key.rotatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{' '}
                <span className="font-normal text-muted">({daysAgo(key.rotatedAt, now)})</span>
              </>
            ) : (
              <span className="font-normal text-muted">never</span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-hairline bg-sunken px-3 py-2">
          <div className={factLabel}>Passes</div>
          <div className="text-[13px] font-semibold">24 h, one per pod start</div>
        </div>
      </div>

      <p className="my-3 flex flex-wrap items-center gap-1.5 text-small text-muted">
        A pass is signed, not stored:
        <span className={chip}>Code Repository</span>
        <span className={chip}>base branch</span>
        <span className={chip}>Ticket branch</span>
        <span className={chip}>expiry</span>
        Harmonic keeps no list of passes.
      </p>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className="rounded-md bg-merged-tint px-3.5 py-3">
          <h4 className="mb-1.5 text-label font-bold uppercase text-merged">A pass allows</h4>
          <ul className="list-disc pl-4 text-[13px] text-ink">
            <li>Fetch the base branch</li>
            <li>Fetch the Ticket branch</li>
            <li>
              Push to <code className={codeInline}>harmonic/task-&lt;id&gt;</code> only, force included (the Rebase Step rewrites the branch)
            </li>
          </ul>
        </div>
        <div className="rounded-md bg-fail-tint px-3.5 py-3">
          <h4 className="mb-1.5 text-label font-bold uppercase text-fail">The proxy denies</h4>
          <ul className="list-disc pl-4 text-[13px] text-ink">
            <li>Tags</li>
            <li>Deleting any ref</li>
            <li>Any other ref</li>
            <li>Every forge API call</li>
          </ul>
        </div>
      </div>

      <hr className="my-4 border-hairline" />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnGhost} onClick={() => setConfirming(true)}>Rotate signing key…</button>
        <span className="text-small text-muted">Replaces the shared key. Do this after a suspected leak or on your own schedule.</span>
        {key?.set && <button type="button" className={btnGhost} onClick={runCheck} disabled={checking}>{checking ? 'Checking…' : 'Check proxy key'}</button>}
      </div>

      {rotation && (
        <div className="mt-3 rounded-lg border border-hairline bg-surface p-3">
          <div role="status" className="flex items-start gap-2.5 rounded-md bg-merged-tint px-3 py-2.5 text-[13px] text-ink">
            <span className="mt-0.5 shrink-0 text-merged"><Icon name="check" /></span>
            <span>
              <b className="font-semibold">{rotatedSummary(rotation.revokedRunning)}</b>
              <span className="mt-0.5 block text-small text-muted">Key must be updated on the Repository Proxy.</span>
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <code aria-label="New signing key, hidden" className="font-data text-muted">••••••••••••</code>
            <button type="button" className="min-h-8 rounded-md border border-edge bg-surface px-2.5 py-0.5 text-small font-medium text-ink transition-colors hover:border-faint" onClick={() => copyKey(rotation.key)}>{copied ? 'Copied' : 'Copy new key'}</button>
            <span className="text-small text-muted">Shown once.</span>
          </div>
        </div>
      )}

      {panel && (
        <div role={panel.tone === 'ok' ? 'status' : 'alert'} className={`mt-3 flex items-start gap-2.5 rounded-md px-3 py-2.5 text-[13px] text-ink ${panel.tone === 'ok' ? 'bg-merged-tint' : 'bg-fail-tint'}`}>
          <span className={`mt-0.5 shrink-0 ${panel.tone === 'ok' ? 'text-merged' : 'text-fail'}`}><Icon name={panel.tone === 'ok' ? 'check' : 'x-circle'} /></span>
          <span>
            <b className="font-semibold">{panel.title}</b>
            <span className="mt-0.5 block text-small text-muted">{panel.body}</span>
          </span>
        </div>
      )}

      {confirming && (
        <Modal label="Rotate signing key" onClose={() => setConfirming(false)} className="max-w-lg">
          <div className="p-5">
            <h2 className="mb-2 pr-6 text-[15px] font-semibold text-ink">
              Rotate the signing key for <code className="font-data text-small">{target.name}</code>?
            </h2>
            <div className="mb-3 rounded-md bg-fail-tint px-3 py-2.5 text-[13px] text-ink">
              <b className="font-semibold text-fail">Running pods lose git access.</b> Rotating the key revokes every outstanding pass.
            </div>
            <ul className="mb-3 list-disc pl-5 text-[13px] text-ink">
              <li><Parts parts={copy.running} codeClass={codeInline} /></li>
              <li>{copy.newPods}</li>
              <li><b>{copy.proxy.bold}</b> {copy.proxy.rest}</li>
            </ul>
            <p className="text-muted">{copy.shownOnce}</p>
            {error && <p role="alert" className="mt-3 text-fail">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={btnQuiet} onClick={() => setConfirming(false)} disabled={rotating}>Cancel</button>
              <button type="button" className={btnDestructive} onClick={rotate} disabled={rotating}>
                {rotating ? 'Rotating…' : 'Rotate key and revoke passes'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
