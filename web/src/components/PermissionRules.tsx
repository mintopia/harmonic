import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PermissionRule } from '../types';
import { btnQuietDestructive, toolChip } from '../ui';
import { useConfirmedDelete } from './useConfirmedDelete';
import { EmptyState } from './EmptyState';
import { PathTail } from './PathTail';

export function PermissionRules({ table = false }: { table?: boolean }) {
  const [rules, setRules] = useState<PermissionRule[]>([]);

  const load = () => api.permissionRules().then(({ rules }) => setRules(rules));
  const { ask: askRevoke, dialog: revokeDialog } = useConfirmedDelete<PermissionRule>(
    (id) => api.deletePermissionRule(id),
    load,
    (rule) => ({
      label: `Revoke ${rule.kind} rule`,
      title: `Revoke this ${rule.kind} rule?`,
      confirmLabel: 'Revoke',
      body: (
        <>
          Agents will be asked again before using it in{' '}
          <span className="font-data text-data break-all text-ink">{rule.workingDir}</span>.
        </>
      ),
    }),
  );
  useEffect(() => {
    load().catch((e) => console.warn('failed to load permission rules', e));
  }, []);

  if (rules.length === 0) {
    return (
      <EmptyState title="No rules yet" className="my-8">
        Click "Always allow" on a permission prompt in a Conversation to add one.
      </EmptyState>
    );
  }

  if (table) {
    return (
      <>
        <table className="w-full border-collapse text-small">
          <thead>
            <tr className="text-left text-badge font-bold uppercase text-muted">
              <th className="border-b border-hairline p-2">Tool kind</th>
              <th className="border-b border-hairline p-2">Working directory</th>
              <th className="border-b border-hairline p-2">Saved</th>
              <th className="border-b border-hairline p-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="border-b border-hairline p-2 font-data">{rule.kind}</td>
                <td className="border-b border-hairline p-2 font-data">{rule.workingDir}</td>
                <td className="border-b border-hairline p-2 text-muted">
                  {new Date(rule.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </td>
                <td className="border-b border-hairline p-2 text-right">
                  <button className={`${btnQuietDestructive} px-2`} onClick={() => askRevoke(rule)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {revokeDialog}
      </>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-2.5">
        {rules.map((rule) => (
          <li key={rule.id} className="flex items-center gap-2">
            <span className={toolChip}>{rule.kind}</span>
            <PathTail path={rule.workingDir} className="flex-1 font-data text-data text-muted" />
            <button
              className={`${btnQuietDestructive} px-2 py-1.5`}
              onClick={() => askRevoke(rule)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {revokeDialog}
    </>
  );
}
