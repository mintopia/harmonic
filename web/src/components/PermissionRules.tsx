import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PermissionRule } from '../types';
import { btnQuietDestructive, toolChip } from '../ui';
import { PathTail } from './PathTail';

/**
 * Persistent Permission Rules (issue #13 / ADR-0007): each row is an
 * operator-visible, revocable auto-approval escalation — created from a
 * Conversation's "Always allow {kind} in {dir}" prompt button, never from
 * here. Like ChannelsSection/ApiPage, this is its own immediately-saved
 * REST resource (load() on mount, delete-then-load() per row) — it never
 * touches the config dirty-state/save-bar.
 */
export function PermissionRules() {
  const [rules, setRules] = useState<PermissionRule[]>([]);

  const load = () => api.permissionRules().then(({ rules }) => setRules(rules));
  useEffect(() => {
    load().catch(() => {});
  }, []);

  if (rules.length === 0) {
    return (
      <p className="text-muted">
        No rules yet — click "Always allow" on a permission prompt in a Conversation to add one.
      </p>
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
