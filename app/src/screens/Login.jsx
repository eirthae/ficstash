import { useState } from 'react';
import Icon from '../components/Icon.jsx';
import { supabase } from '../lib/supabase.js';

// Sign-in gate. FicStash is a single-owner private archive: the library lives in
// Supabase and (since migration 0015) every table requires a logged-in owner
// session, so the public anon key can't read anything. You sign in once; the
// session is stored in Capacitor Preferences and survives cold starts.
//
// This is NOT an AO3 login — it's your own FicStash account. No AO3 credentials
// are ever entered or stored anywhere.
export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e && e.preventDefault();
    if (busy) return;
    setError('');
    const em = email.trim();
    if (!em || !password) { setError('Enter your email and password.'); return; }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: em, password });
      if (error) throw error;
      // On success, App's onAuthStateChange swaps this screen for the library.
    } catch (err) {
      setError(err?.message || 'Could not sign in. Check your details and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="screen" data-mode="dark" style={{ background: 'var(--bg)' }}>
      <div className="scroll" style={{ padding: '0 28px', display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100%' }}>
        <div style={{ width: 72, height: 72, borderRadius: 20, background: 'linear-gradient(150deg,#7828c8,#006fee)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', boxShadow: 'var(--shadow-pop)' }}>
          <Icon icon="solar:lock-keyhole-bold" size={34} color="#fff" />
        </div>
        <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', marginBottom: 8 }}>Welcome back</div>
        <div style={{ textAlign: 'center', fontSize: 14, lineHeight: 1.55, color: 'var(--text-secondary)', maxWidth: 300, margin: '0 auto 26px' }}>
          Sign in to continue.
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="searchfield" style={{ background: 'var(--surface-2)' }}>
            <Icon icon="solar:letter-linear" size={18} color="var(--text-tertiary)" />
            <input type="email" placeholder="Email" value={email}
              onChange={e => setEmail(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="email" autoComplete="username" />
          </div>
          <div className="searchfield" style={{ background: 'var(--surface-2)' }}>
            <Icon icon="solar:lock-password-linear" size={18} color="var(--text-tertiary)" />
            <input type="password" placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="current-password" />
          </div>

          {error && (
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 13px', borderRadius: 'var(--radius-md)', background: 'var(--danger-soft, rgba(243,18,96,.12))' }}>
              <Icon icon="solar:danger-triangle-bold" size={17} color="var(--danger, #f31260)" style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-secondary)' }}>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-lg btn-primary btn-block" disabled={busy} style={{ marginTop: 4 }}>
            {busy ? 'Signing in…' : <><Icon icon="solar:login-3-bold" size={19} /> Sign in</>}
          </button>
        </form>

        <div style={{ display: 'flex', gap: 10, padding: 13, borderRadius: 'var(--radius-md)', background: 'var(--info-soft)', marginTop: 22 }}>
          <Icon icon="solar:shield-keyhole-linear" size={19} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            This is your own FicStash account — not AO3. FicStash never asks for or stores any AO3 password.
          </div>
        </div>
      </div>
    </div>
  );
}
