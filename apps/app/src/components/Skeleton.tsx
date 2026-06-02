import type { CSSProperties } from 'react'

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export function Skeleton({
  className,
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={cx('dohc-skeleton', className)}
      style={style}
      aria-hidden="true"
    />
  )
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  const widths = ['92%', '86%', '74%', '68%']
  return (
    <div className={cx(className, 'space-y-2')} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-2.5 rounded-full"
          style={{ width: widths[i % widths.length] }}
        />
      ))}
    </div>
  )
}

export function WorkspaceButtonSkeleton() {
  return (
    <div
      className="mx-3 mb-1 flex h-8 items-center gap-2 rounded-md px-2"
      aria-hidden="true"
    >
      <Skeleton className="size-3.5 shrink-0 rounded-full" />
      <Skeleton className="h-2.5 w-24 rounded-full" />
      <Skeleton className="ml-auto size-3.5 rounded-full" />
    </div>
  )
}

export function SidebarRowsSkeleton({
  rows = 7,
  className,
}: {
  rows?: number
  className?: string
}) {
  return (
    <div className={cx(className, 'space-y-1')} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex h-8 items-center gap-2 rounded-md px-2"
          style={{ paddingLeft: i > 4 ? 18 : undefined }}
        >
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton
            className="h-2.5 rounded-full"
            style={{ width: i % 3 === 0 ? '72%' : i % 3 === 1 ? '58%' : '84%' }}
          />
        </div>
      ))}
    </div>
  )
}

export function SidebarListSkeleton({
  groups = 2,
  rowsPerGroup = 4,
  className,
}: {
  groups?: number
  rowsPerGroup?: number
  className?: string
}) {
  if (groups === 1) {
    return <SidebarRowsSkeleton rows={rowsPerGroup} className={className} />
  }

  return (
    <div className={cx(className, 'space-y-5')} aria-hidden="true">
      {Array.from({ length: groups }).map((_, group) => (
        <section key={group}>
          <Skeleton className="mb-2 h-2 w-20 rounded-full" />
          <SidebarRowsSkeleton rows={rowsPerGroup} />
        </section>
      ))}
    </div>
  )
}

export function CardStackSkeleton({
  cards = 2,
  className,
}: {
  cards?: number
  className?: string
}) {
  return (
    <div className={cx(className, 'flex flex-col gap-3')} aria-hidden="true">
      {Array.from({ length: cards }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-rule bg-surface px-3.5 py-3"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton
                className="h-3 rounded-full"
                style={{ width: i % 2 === 0 ? '58%' : '72%' }}
              />
              <Skeleton className="h-2.5 rounded-full" style={{ width: '86%' }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function DocumentSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cx(
        'doc doc-editing mx-auto w-full max-w-[760px] px-6',
        compact ? 'py-8' : 'py-12',
      )}
      aria-hidden="true"
    >
      <Skeleton className="h-8 w-[62%] rounded-md" />
      <div className="mt-8 space-y-7">
        <SkeletonText lines={3} className="max-w-[680px]" />
        <div className="space-y-2.5">
          <div className="flex max-w-[700px] items-center gap-3">
            <Skeleton className="h-2.5 w-16 shrink-0 rounded-full" />
            <Skeleton className="h-px flex-1 rounded-full" />
          </div>
          <SkeletonText lines={3} className="max-w-[720px]" />
        </div>
        <Skeleton className="h-28 max-w-[700px] rounded-md" />
        {!compact && <SkeletonText lines={5} className="max-w-[700px]" />}
      </div>
    </div>
  )
}

export function ViewFrameSkeleton({
  withHeader = false,
}: {
  withHeader?: boolean
}) {
  return (
    <main className="flex h-full min-w-0 flex-col bg-page" aria-hidden="true">
      {withHeader && (
        <header className="flex h-12 items-center justify-between border-b border-rule bg-surface px-4">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-36 rounded-full" />
            <Skeleton className="mt-2 h-2.5 w-56 rounded-full" />
          </div>
          <Skeleton className="h-8 w-24 rounded-md" />
        </header>
      )}
      <ViewSurfaceSkeleton />
    </main>
  )
}

export function ViewSurfaceSkeleton() {
  return (
    <section className="relative min-h-0 flex-1 overflow-hidden bg-page" aria-hidden="true">
      <div className="absolute inset-0 bg-surface">
        <div className="p-6">
          <Skeleton className="h-5 w-48 rounded-md" />
          <div className="mt-5 grid max-w-4xl gap-3 sm:grid-cols-3">
            <Skeleton className="h-24 rounded-md" />
            <Skeleton className="h-24 rounded-md" />
            <Skeleton className="h-24 rounded-md" />
          </div>
          <SkeletonText lines={4} className="mt-6 max-w-2xl" />
        </div>
      </div>
    </section>
  )
}

function ActivityRailSkeleton() {
  return (
    <nav className="flex h-screen w-12 flex-col items-center gap-1 border-r border-rule bg-panel py-3" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="relative grid size-9 place-items-center rounded-md">
          {i === 0 && (
            <span className="absolute left-[-12px] top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-ink-strong/35" />
          )}
          <Skeleton className="size-[18px] rounded-[4px]" />
        </div>
      ))}
    </nav>
  )
}

function SidebarHeaderSkeleton() {
  return (
    <header className="flex items-center justify-between px-4 pb-3 pt-4" aria-hidden="true">
      <div className="flex items-center gap-2">
        <Skeleton className="size-5 rounded-md" />
        <Skeleton className="h-4 w-14 rounded-full" />
      </div>
      <div className="flex items-center gap-0.5">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
    </header>
  )
}

function SidebarSectionSkeleton({
  rows = 5,
  divider = false,
}: {
  rows?: number
  divider?: boolean
}) {
  return (
    <section className={cx(divider && 'mt-1 border-t border-rule pt-1')} aria-hidden="true">
      <div className="flex items-center pl-2.5 pr-2">
        <div className="flex flex-1 items-center gap-1 py-1">
          <Skeleton className="size-3 shrink-0 rounded-[3px]" />
          <Skeleton className="h-2 w-28 rounded-full" />
        </div>
      </div>
      <SidebarRowsSkeleton rows={rows} className="px-1.5 pt-1" />
    </section>
  )
}

function SidebarFooterSkeleton() {
  return (
    <footer className="border-t border-rule px-3 py-2.5" aria-hidden="true">
      <div className="flex items-center gap-2">
        <Skeleton className="size-2 shrink-0 rounded-full" />
        <Skeleton className="h-2.5 min-w-0 flex-1 rounded-full" />
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="h-2.5 w-10 rounded-full" />
      </div>
    </footer>
  )
}

export function ChatMessagesSkeleton({ primary = false }: { primary?: boolean }) {
  return (
    <div className={cx('space-y-5', primary && 'pt-2')} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={cx(
            'flex',
            i === 1 ? 'justify-end' : 'justify-start',
          )}
        >
          <div
            className={cx(
              'rounded-lg border border-rule bg-elevated px-3 py-3',
              primary ? 'w-[min(620px,88%)]' : 'w-[86%]',
            )}
          >
            <Skeleton
              className="h-2.5 rounded-full"
              style={{ width: i === 1 ? '46%' : '62%' }}
            />
            <SkeletonText lines={i === 1 ? 2 : 3} className="mt-3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function AppLoadingScreen() {
  return (
    <div
      className="grid h-screen grid-cols-[48px_minmax(0,1fr)] overflow-hidden bg-page text-ink sm:grid-cols-[48px_260px_1fr]"
      role="status"
      aria-label="Loading dohc workspace"
    >
      <ActivityRailSkeleton />
      <aside className="hidden h-screen min-w-0 flex-col overflow-hidden border-r border-rule bg-panel sm:flex">
        <SidebarHeaderSkeleton />
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          <SidebarSectionSkeleton rows={6} />
          <SidebarSectionSkeleton rows={3} divider />
        </div>
        <WorkspaceButtonSkeleton />
        <SidebarFooterSkeleton />
      </aside>
      <main className="pane min-w-0 bg-page">
        <header className="sticky top-0 z-20 flex h-11 items-center border-b border-rule bg-page/85 px-6 backdrop-blur-md">
          <Skeleton className="h-3.5 w-56 rounded-full" />
        </header>
        <DocumentSkeleton />
      </main>
    </div>
  )
}
