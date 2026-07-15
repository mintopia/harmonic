import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { btnGhost, field } from '../ui';
import { fieldLabel } from './SettingsSection';

/** Changes the operator password. Deliberately its own form with its own
 * submit button — a credential rotation isn't part of the config object, so
 * it never touches the Settings page's dirty-state/save-bar machinery. */
export function SecuritySection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setConfirmed(false);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={fieldLabel} htmlFor="security-current-password">Current Password</label>
        <input
          id="security-current-password"
          type="password"
          autoComplete="current-password"
          className={field}
          value={currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            setConfirmed(false);
          }}
        />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="security-new-password">New Password</label>
        <input
          id="security-new-password"
          type="password"
          autoComplete="new-password"
          className={field}
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            setConfirmed(false);
          }}
        />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={busy || !currentPassword || !newPassword}
          className={btnGhost}
        >
          {busy ? 'Changing…' : 'Change password'}
        </button>
        {confirmed && <p className="text-accept">Password changed.</p>}
        {error && <p className="text-fail">{error}</p>}
      </div>
    </form>
  );
}
