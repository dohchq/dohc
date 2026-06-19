import { useEffect, useState } from 'react'
import { DohcLogo } from '@dohc/brand'
import { CloudApiError, createCloudApi, type CloudApi, type SharedAtom } from './cloudApi'
import { MarkdownBody } from './MarkdownBody'

type ShareState =
  | { status: 'loading' }
  | { status: 'ready'; atom: SharedAtom }
  | { status: 'denied' }
  | { status: 'missing' }
  | { status: 'error' }

// Shared-link viewing. Both `/shared/$shareId` (legacy grant URLs — the
// id those links carry IS the shared atom id) and `/r/$atomId` resolve
// through GET /shared/atoms/:atomId, which requires a signed-in session
// and answers 403/404 for revoked/unknown shares.
export function SharedAtomPage({ atomId, api }: { atomId: string; api?: CloudApi }) {
  const [state, setState] = useState<ShareState>({ status: 'loading' })

  useEffect(() => {
    const cloudApi = api ?? createCloudApi()
    let cancelled = false
    setState({ status: 'loading' })
    cloudApi
      .getSharedAtom(atomId)
      .then((atom) => {
        if (!cancelled) setState({ status: 'ready', atom })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof CloudApiError && (error.status === 401 || error.status === 403)) {
          setState({ status: 'denied' })
        } else if (error instanceof CloudApiError && error.status === 404) {
          setState({ status: 'missing' })
        } else {
          setState({ status: 'error' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, atomId])

  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="flex h-12 items-center gap-3 border-b border-rule bg-surface px-4">
        <a href="/" className="flex items-center gap-2 text-accent" aria-label="dohc home">
          <DohcLogo size="sm" />
        </a>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
          {state.status === 'ready' ? state.atom.path : 'shared page'}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
          shared · {state.status === 'ready' ? state.atom.capability : 'dohc Cloud'}
        </span>
      </header>
      <main className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
        {state.status === 'loading' && (
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            loading…
          </p>
        )}
        {state.status === 'denied' && (
          <ShareNotice
            title="Sign in to view this page"
            body="This shared page needs a dohc Cloud session, and your account must still hold the share."
            cta={{ href: '/', label: 'Go to sign in' }}
          />
        )}
        {state.status === 'missing' && (
          <ShareNotice
            title="This shared page is gone"
            body="The link may have been revoked, or the page no longer exists."
          />
        )}
        {state.status === 'error' && (
          <ShareNotice
            title="Could not load this page"
            body="Something went wrong on our side. Try again in a moment."
          />
        )}
        {state.status === 'ready' && (
          <article data-testid="shared-atom-body">
            <MarkdownBody body={state.atom.body} />
          </article>
        )}
      </main>
    </div>
  )
}

function ShareNotice({
  title,
  body,
  cta,
}: {
  title: string
  body: string
  cta?: { href: string; label: string }
}) {
  return (
    <div className="rounded-[14px] border border-rule bg-surface px-6 py-8 text-center">
      <h1 className="font-serif text-[20px] text-ink-strong">{title}</h1>
      <p className="mx-auto mt-2 max-w-[360px] text-[13px] leading-relaxed text-ink-dim">{body}</p>
      {cta && (
        <a
          href={cta.href}
          className="mt-5 inline-flex h-9 items-center rounded-lg bg-ink-strong px-4 text-[13px] font-medium text-surface"
        >
          {cta.label}
        </a>
      )}
    </div>
  )
}
