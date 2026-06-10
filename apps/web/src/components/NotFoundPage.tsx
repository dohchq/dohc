import { ArrowLeft, FileQuestion, Home, Search } from 'lucide-react'
import { DohcLogo } from '@dohc/brand'

type NotFoundPageProps = {
  mode?: 'full' | 'workspace'
  data?: unknown
  isNotFound?: boolean
  routeId?: string
}

export function NotFoundPage({ mode = 'full' }: NotFoundPageProps = {}) {
  const rootClassName =
    mode === 'workspace'
      ? 'relative grid min-h-full overflow-hidden bg-page px-6 py-8 text-ink'
      : 'relative grid min-h-screen overflow-hidden bg-page px-6 py-8 text-ink'

  return (
    <main className={rootClassName}>
      <div
        aria-hidden
        className="absolute inset-0 opacity-100"
        style={{
          backgroundImage:
            'linear-gradient(90deg, var(--dohc-grid) 1px, transparent 1px), linear-gradient(0deg, var(--dohc-grid) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-[580px] w-[580px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-rule opacity-60"
      />
      <div className="relative mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[0.95fr_1.05fr]">
        <section className="max-w-xl">
          <div className="mb-10 inline-flex items-center gap-3 text-accent">
            <DohcLogo size="md" />
            <span className="font-mono text-[11px] font-semibold uppercase text-ink-faint">
              missing route
            </span>
          </div>

          <p className="font-mono text-[12px] font-semibold uppercase text-ink-faint">
            404
          </p>
          <h1 className="mt-3 max-w-[11ch] font-serif text-[52px] leading-[0.9] text-ink-strong sm:text-[72px] lg:text-[96px]">
            This page is not in the workspace.
          </h1>
          <p className="mt-7 max-w-md text-[15px] leading-7 text-ink-dim">
            The link may be old, private, or typed a little differently than
            dohc expected.
          </p>

          <div className="mt-9 flex flex-col gap-2.5 sm:flex-row">
            <a
              href="/"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink-strong px-4 text-[13px] font-medium text-surface shadow-sm transition-[background,transform,box-shadow] hover:-translate-y-px hover:bg-accent-hover hover:shadow-md"
            >
              <Home className="size-4" strokeWidth={2} />
              <span>Open workspace</span>
            </a>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-rule bg-surface px-4 text-[13px] font-medium text-ink-dim shadow-xs transition-[border,background,color,transform] hover:-translate-y-px hover:border-rule-strong hover:bg-hover hover:text-ink"
            >
              <ArrowLeft className="size-4" strokeWidth={2} />
              <span>Go back</span>
            </button>
          </div>
        </section>

        <section
          aria-hidden
          className="relative mx-auto aspect-[1.04] w-full max-w-[520px]"
        >
          <div className="absolute inset-x-[14%] top-[12%] h-[72%] rotate-[-4deg] rounded-lg border border-rule-strong bg-surface shadow-lg" />
          <div className="absolute inset-x-[18%] top-[8%] h-[76%] rotate-[3deg] rounded-lg border border-rule bg-elevated shadow-md" />
          <div className="absolute inset-x-[22%] top-[18%] h-[64%] rounded-lg border border-rule bg-page p-6 shadow-sm">
            <div className="flex items-center justify-between border-b border-rule pb-4">
              <FileQuestion className="size-7 text-ink-dim" strokeWidth={1.7} />
              <span className="font-mono text-[11px] uppercase text-ink-faint">
                no match
              </span>
            </div>
            <div className="mt-8 space-y-4">
              <div className="h-3 w-28 rounded-full bg-ink-ghost" />
              <div className="h-3 w-full rounded-full bg-hover" />
              <div className="h-3 w-[82%] rounded-full bg-hover" />
              <div className="h-3 w-[58%] rounded-full bg-hover" />
            </div>
            <div className="absolute bottom-6 right-6 grid size-14 place-items-center rounded-full border border-rule bg-surface shadow-md">
              <Search className="size-5 text-ink-dim" strokeWidth={1.8} />
            </div>
          </div>
          <div className="absolute bottom-[8%] left-[10%] rounded-md border border-rule bg-surface px-3 py-2 font-mono text-[11px] text-ink-faint shadow-sm">
            path unresolved
          </div>
          <div className="absolute right-[12%] top-[9%] rounded-md border border-rule bg-surface px-3 py-2 font-mono text-[11px] text-ink-faint shadow-sm">
            source absent
          </div>
        </section>
      </div>
    </main>
  )
}
