import { useState, type FormEvent } from 'react';
import { btnPrimary, field } from '../ui';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('operator');
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
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) onLoggedIn();
    else {
      setError(res.status === 401 ? 'Wrong password.' : `Login failed (${res.status}).`);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-80 rounded-md border border-hairline bg-surface p-6">
        <h1 className="mb-4 text-center text-title font-semibold">AgentDeck</h1>
        <input
          type="text"
          aria-label="Username"
          autoComplete="username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={`${field} mb-3`}
        />
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
