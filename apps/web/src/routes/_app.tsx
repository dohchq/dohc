import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { DohcLogo } from '@dohc/brand'
import { InstallDesktopPrompt } from '@/components/InstallDesktopPrompt'
import { createCloudApi } from '@/cloud/cloudApi'
import { SignInForm } from '@/cloud/SignInForm'
import { CloudSessionProvider } from '@/cloud/session'
import type { CloudUser } from '@/cloud/cloudApi'

// The dohc Cloud shell layout. The web app is the CLOUD client: browser
// access to your synced workspaces plus shared links. Signed out, every
// /_app URL shows the splash (sign in via Better Auth email+password);
// signed in, child routes render inside the cloud session.
export const Route = createFileRoute('/_app')({
  component: AppLayout,
})

type SessionState = { status: 'loading' } | { status: 'ready'; user: CloudUser | null }

function AppLayout() {
  const api = useMemo(() => createCloudApi(), [])
  const [session, setSession] = useState<SessionState>({ status: 'loading' })

  const refreshSession = useCallback(() => {
    api
      .getSession()
      .then((user) => setSession({ status: 'ready', user }))
      .catch(() => setSession({ status: 'ready', user: null }))
  }, [api])

  useEffect(() => {
    refreshSession()
  }, [refreshSession])

  const signOut = useCallback(() => {
    api.signOut().finally(() => setSession({ status: 'ready', user: null }))
  }, [api])

  if (session.status === 'loading') {
    return (
      <div className="grid h-screen place-items-center bg-page">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          dohc cloud…
        </p>
      </div>
    )
  }
  if (!session.user) {
    return <SignInSplash onSignedIn={refreshSession} />
  }
  return (
    <CloudSessionProvider value={{ user: session.user, api, signOut }}>
      <Outlet />
    </CloudSessionProvider>
  )
}

// The signed-out splash keeps the original sign-in card's visual
// language: grid paper, one calm card, the mark, serif headline, mono
// caption — with the Better Auth email+password form inline.
function SignInSplash({ onSignedIn }: { onSignedIn: () => void }) {
  const api = useMemo(() => createCloudApi(), [])
  return (
    <div
      className="grid min-h-screen place-items-center bg-page px-6 py-10"
      style={{
        backgroundImage:
          'linear-gradient(90deg, var(--dohc-grid) 1px, transparent 1px), linear-gradient(0deg, var(--dohc-grid) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }}
    >
      <div className="w-[420px] max-w-[92vw] rounded-[18px] border border-rule bg-surface px-10 py-12 shadow-md">
        <div className="flex flex-col items-center gap-4 text-accent">
          <DohcLogo size="lg" />
        </div>

        <h1 className="mt-8 text-center font-serif text-[30px] leading-[1.1] text-ink-strong">
          Your workspace, in any browser.
        </h1>

        <p className="mx-auto mt-3 max-w-[300px] text-center text-[13.5px] leading-relaxed text-ink-dim">
          dohc Cloud keeps your synced workspaces and shared pages a sign-in
          away — on any device.
        </p>

        <div className="mt-8">
          <SignInForm api={api} onSignedIn={onSignedIn} />
        </div>

        <p className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
          secure sign-in · your work stays private
        </p>

        <InstallDesktopPrompt className="mt-7" />
      </div>
    </div>
  )
}
