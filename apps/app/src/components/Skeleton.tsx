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
      className="mx-3 mt-1 mb-2 flex h-7 items-center gap-1.5 rounded-md px-2"
      aria-hidden="true"
    >
      <Skeleton className="size-3.5 shrink-0 rounded-full" />
      <Skeleton className="h-2.5 w-24 rounded-full" />
      <Skeleton className="ml-auto size-3 rounded-full" />
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
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
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
      <div className="mt-8 space-y-6">
        <SkeletonText lines={3} className="max-w-[680px]" />
        <SkeletonText lines={4} className="max-w-[720px]" />
        <div className="rounded-md border border-rule bg-surface p-4">
          <Skeleton className="h-3 w-36 rounded-full" />
          <SkeletonText lines={3} className="mt-4 max-w-[620px]" />
        </div>
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
    <main className="flex min-w-0 flex-col bg-page" aria-hidden="true">
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
    <section className="grid min-h-0 flex-1 place-items-center px-6" aria-hidden="true">
      <div className="w-full max-w-3xl rounded-lg border border-rule bg-surface p-5">
        <Skeleton className="h-5 w-48 rounded-md" />
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-24 rounded-md" />
          <Skeleton className="h-24 rounded-md" />
          <Skeleton className="h-24 rounded-md" />
        </div>
        <SkeletonText lines={4} className="mt-6 max-w-2xl" />
      </div>
    </section>
  )
}

export function GraphSkeleton() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-page" aria-hidden="true">
      <Skeleton className="absolute left-[14%] top-[18%] size-12 rounded-full" />
      <Skeleton className="absolute left-[42%] top-[30%] size-16 rounded-full" />
      <Skeleton className="absolute right-[18%] top-[20%] size-10 rounded-full" />
      <Skeleton className="absolute bottom-[24%] left-[28%] size-10 rounded-full" />
      <Skeleton className="absolute bottom-[18%] right-[30%] size-14 rounded-full" />
      <div className="absolute left-[18%] right-[18%] top-[44%] h-px rotate-6 bg-rule" />
      <div className="absolute left-[35%] right-[24%] top-[38%] h-px -rotate-12 bg-rule" />
      <div className="absolute bottom-[30%] left-[30%] right-[32%] h-px rotate-3 bg-rule" />
    </div>
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
      className="grid h-screen grid-cols-[48px_260px_1fr] overflow-hidden bg-page text-ink"
      role="status"
      aria-label="Loading dohc workspace"
    >
      <div className="border-r border-rule bg-surface px-2 py-3">
        <Skeleton className="mx-auto size-7 rounded-md" />
        <div className="mt-6 space-y-3">
          <Skeleton className="mx-auto size-7 rounded-md" />
          <Skeleton className="mx-auto size-7 rounded-md" />
          <Skeleton className="mx-auto size-7 rounded-md" />
        </div>
      </div>
      <aside className="border-r border-rule bg-panel">
        <div className="h-24 border-b border-rule px-3 py-3">
          <Skeleton className="h-5 w-24 rounded-md" />
          <Skeleton className="mt-5 h-8 rounded-md" />
        </div>
        <WorkspaceButtonSkeleton />
        <SidebarListSkeleton className="px-3 pt-4" groups={2} rowsPerGroup={5} />
      </aside>
      <main className="min-w-0 bg-page">
        <div className="h-11 border-b border-rule px-6 py-3">
          <Skeleton className="h-3.5 w-56 rounded-full" />
        </div>
        <DocumentSkeleton />
      </main>
    </div>
  )
}
