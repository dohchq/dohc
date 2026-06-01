import { type ReactNode } from 'react'
import { Monitor, Moon, Plus, Search, Sun } from 'lucide-react'
import { DohcMark } from './DohcLogo'
import { useTheme } from '../lib/use-theme'

export type SidebarUser = {
  email?: string | null
  firstName?: string | null
} | null

export function SidebarHeader({
  onOpenSearch,
  onCreate,
  createLabel = 'new',
  createControl,
}: {
  onOpenSearch?: () => void
  onCreate?: () => void
  createLabel?: string
  createControl?: ReactNode
}) {
  return (
    <header className="flex items-center justify-between px-4 pb-3 pt-4">
      <div className="flex items-center gap-2 text-accent">
        <DohcMark size={20} />
        <span className="text-[16px] font-semibold leading-none tracking-tight text-ink-strong">
          dohc
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        {onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            title="search (⌘⇧F)"
            aria-label="search pages"
          >
            <Search className="size-4" strokeWidth={2} />
          </button>
        )}
        {createControl ??
          (onCreate ? (
            <button
              type="button"
              onClick={onCreate}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
              title={createLabel}
              aria-label={createLabel}
            >
              <Plus className="size-4" strokeWidth={2} />
            </button>
          ) : null)}
      </div>
    </header>
  )
}

export function SidebarAccountFooter({ user }: { user: SidebarUser }) {
  const label = user?.firstName || user?.email?.split('@')[0] || 'signed in'

  return (
    <footer className="border-t border-rule px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-2"
          title={user?.email ?? ''}
        >
          <span className="size-2 shrink-0 rounded-full bg-success" />
          <span className="truncate text-[11.5px] text-ink-dim">{label}</span>
        </div>
        <ThemeToggleButton />
        <a
          href="/api/auth/sign-out"
          className="text-[10.5px] text-ink-faint transition-colors hover:text-ink-dim"
          title="sign out"
        >
          sign out
        </a>
      </div>
    </footer>
  )
}

function ThemeToggleButton() {
  const { theme, cycle } = useTheme()
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  const next =
    theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'

  return (
    <button
      type="button"
      onClick={cycle}
      title={`theme: ${theme} · click for ${next}`}
      aria-label="cycle theme"
      className="flex size-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
    >
      <Icon className="size-3.5" strokeWidth={2} />
    </button>
  )
}
