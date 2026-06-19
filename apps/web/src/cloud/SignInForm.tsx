import { useState, type FormEvent } from 'react'
import type { CloudApi } from './cloudApi'

// Better Auth email+password form for the signed-out splash. Posts to
// /api/auth/sign-in/email (or sign-up) with cookie credentials; on
// success the caller re-checks the session.
export function SignInForm({
  api,
  onSignedIn,
}: {
  api: CloudApi
  onSignedIn: () => void
}) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'sign-up') {
        await api.signUpWithEmail({ email, password, name: name || email })
      } else {
        await api.signInWithEmail({ email, password })
      }
      onSignedIn()
    } catch {
      setError(
        mode === 'sign-up'
          ? 'Could not create the account. Try a different email.'
          : 'Sign-in failed. Check your email and password.',
      )
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'h-10 w-full rounded-lg border border-rule bg-page px-3 text-[13.5px] text-ink outline-none focus:border-rule-strong'

  return (
    <form data-testid="sign-in-form" onSubmit={submit} className="flex flex-col gap-2.5">
      {mode === 'sign-up' && (
        <input
          data-testid="sign-in-name"
          type="text"
          autoComplete="name"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      )}
      <input
        data-testid="sign-in-email"
        type="email"
        required
        autoComplete="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={inputClass}
      />
      <input
        data-testid="sign-in-password"
        type="password"
        required
        autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className={inputClass}
      />
      {error && (
        <p role="alert" className="text-[12px] leading-snug text-danger">
          {error}
        </p>
      )}
      <button
        data-testid="sign-in-submit"
        type="submit"
        disabled={busy}
        className="group mt-1 flex h-11 items-center justify-center gap-2 rounded-lg bg-ink-strong text-surface text-[13.5px] font-medium tracking-wide shadow-sm transition-all hover:translate-y-[-1px] hover:shadow-md disabled:opacity-60"
      >
        <span>{mode === 'sign-up' ? 'Create account' : 'Sign in'}</span>
        <span aria-hidden className="text-[16px] leading-none transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </button>
      <button
        data-testid="sign-in-mode-toggle"
        type="button"
        onClick={() => {
          setError(null)
          setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
        }}
        className="mt-1 text-center text-[12px] text-ink-dim hover:text-ink"
      >
        {mode === 'sign-in' ? 'New here? Create an account' : 'Have an account? Sign in'}
      </button>
    </form>
  )
}
