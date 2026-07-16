import { useState, type FormEvent } from 'react';
import { BrandMark } from './BrandMark';
import { btnPrimary, card, displayTitle, field } from '../ui';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) onLoggedIn();
    else {
      setError(res.status === 401 ? 'Wrong password.' : `Login failed (${res.status}).`);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className={`${card} w-full max-w-sm p-6`}>
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <h1 className={displayTitle}>Harmonic</h1>
        </div>
        <p className="mb-5 mt-1.5 text-muted">Operator console</p>
        <input
          type="password"
          autoFocus
          aria-label="Operator password"
          autoComplete="current-password"
          placeholder="Operator password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={`${field} mb-3`}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        <button type="submit" disabled={busy || !password} className={`${btnPrimary} w-full`}>
          Log in
        </button>
      </form>
    </div>
  );
}
