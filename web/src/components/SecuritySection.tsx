import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { btnGhost, btnQuietDestructive, field } from '../ui';
import { fieldLabel } from './SettingsSection';

export function SecuritySection() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((me: { passwordConfigured: boolean }) => setConfigured(me.passwordConfigured))
      .catch(() => setConfigured(true));
  }, []);

  const run = async (fn: () => Promise<unknown>, thenReload: boolean) => {
    setBusy(true);
    setError(null);
    setConfirmed(false);
    try {
      await fn();
      if (thenReload) location.reload();
      else {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmed(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => api.changePassword(currentPassword, newPassword), !configured);
  };

  if (configured === null) return null;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      {configured && (
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
      )}
      <div>
        <label className={fieldLabel} htmlFor="security-new-password">
          {configured ? 'New Password' : 'Password'}
        </label>
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
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={busy || !newPassword || (configured && !currentPassword)} className={btnGhost}>
          {busy ? 'Saving…' : configured ? 'Change password' : 'Set password'}
        </button>
        {configured && (
          <button
            type="button"
            disabled={busy || !currentPassword}
            className={btnQuietDestructive}
            onClick={() => run(() => api.removePassword(currentPassword), true)}
          >
            Remove password
          </button>
        )}
        {!configured && (
          <p className="text-small text-muted">No password set — this console is ungated. Set one to require login.</p>
        )}
        {confirmed && <p className="text-muted">Password changed.</p>}
        {error && <p className="text-fail">{error}</p>}
      </div>
    </form>
  );
}
