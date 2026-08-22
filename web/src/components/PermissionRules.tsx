import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PermissionRule } from '../types';
import { btnQuietDestructive, toolChip } from '../ui';
import { EmptyState } from './EmptyState';
import { PathTail } from './PathTail';

export function PermissionRules() {
  const [rules, setRules] = useState<PermissionRule[]>([]);

  const load = () => api.permissionRules().then(({ rules }) => setRules(rules));
  useEffect(() => {
    load().catch(() => {});
  }, []);

  if (rules.length === 0) {
    return (
      <EmptyState title="No rules yet" className="my-8">
        Click "Always allow" on a permission prompt in a Conversation to add one.
      </EmptyState>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {rules.map((rule) => (
        <li key={rule.id} className="flex items-center gap-2">
          <span className={toolChip}>{rule.kind}</span>
          <PathTail path={rule.workingDir} className="flex-1 font-data text-data text-muted" />
          <button
            className={`${btnQuietDestructive} px-2 py-1.5`}
            onClick={() => api.deletePermissionRule(rule.id).then(load)}
          >
            Revoke
          </button>
        </li>
      ))}
    </ul>
  );
}
