import { createFileRoute } from '@tanstack/react-router'
import { DohcLogo } from '@dohc/brand'
import { useCloudSession } from '@/cloud/session'
import { WorkspaceList } from '@/cloud/WorkspaceList'

// Signed-in home: the user's cloud workspaces. Workspace home URLs are
// `/<workspaceId>`.
export const Route = createFileRoute('/_app/')({
  component: Home,
})

function Home() {
  const { user, api, signOut } = useCloudSession()
  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="flex h-12 items-center gap-3 border-b border-rule bg-surface px-4">
        <span className="flex items-center gap-2 text-accent">
          <DohcLogo size="sm" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
          dohc Cloud
        </span>
        <span className="hidden truncate text-[12px] text-ink-dim sm:block">{user.email}</span>
        <button
          type="button"
          data-testid="sign-out-button"
          onClick={signOut}
          className="h-7 rounded-md px-2.5 text-[12px] text-ink-dim hover:bg-hover hover:text-ink"
        >
          Sign out
        </button>
      </header>
      <main className="mx-auto max-w-[640px] px-4 py-10 sm:px-6">
        <h1 className="font-serif text-[24px] text-ink-strong">Your workspaces</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">
          Open a synced workspace to read and edit it in the browser.
        </p>
        <div className="mt-6">
          <WorkspaceList api={api} />
        </div>
      </main>
    </div>
  )
}
