/**
 * Top-of-sidebar workspace switcher (org-plan §9 Phase D).
 *
 * Compact dropdown that sits between the brand header and the search
 * box at the top of the FileTree. Shows the active workspace's name;
 * clicking opens a list of "personal + every org I'm an active member
 * of" with a checkmark on the active one. Picking an entry calls
 * `setActiveWorkspaceId` and the rest of the app reactively re-queries
 * with the new workspaceId via `useActiveWorkspaceId()`.
 *
 * `api.orgs.myWorkspaces` is the single source of truth for the list
 * (personal first, then active orgs). The active entry is matched by
 * comparing each row's `workspaceId` against the context's value
 * (undefined ⇒ personal entry).
 */
import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Plus,
  Settings,
  User as UserIcon,
  Building2,
} from 'lucide-react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspace } from '@/lib/active-workspace'
import { WorkspaceManagementDialog } from './WorkspaceManagementDialog'

export function WorkspaceSwitcher() {
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveWorkspace()
  const workspaces = useQuery(api.orgs.myWorkspaces, {})
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  // Click-outside to close. (The same pattern the New + menu in
  // FileTree uses — fixed overlay catches the click.)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        popoverRef.current &&
        !popoverRef.current.contains(t) &&
        buttonRef.current &&
        !buttonRef.current.contains(t)
      ) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Loading: render a stable empty button-frame (no skeleton churn).
  if (workspaces === undefined) {
    return (
      <div
        className="mx-3 mt-1 mb-2 h-7 rounded-md border border-rule/60 bg-transparent"
        aria-hidden
      />
    )
  }

  // Self-heal: if the persisted activeWorkspaceId points at an org the
  // caller is NOT (or no longer) a member of, reset to personal so the
  // sidebar doesn't get stuck on a workspace whose queries will all
  // reject. This is the offboarded-mid-tab recovery path.
  const known = workspaces.find((w) => w.workspaceId === activeWorkspaceId)
  const isStale = activeWorkspaceId !== undefined && !known
  useEffect(() => {
    if (isStale) setActiveWorkspaceId(undefined)
  }, [isStale, setActiveWorkspaceId])

  // Resolve the row to display. undefined activeWorkspaceId ⇒ personal
  // (which myWorkspaces always returns first).
  const active =
    activeWorkspaceId === undefined
      ? workspaces[0]
      : known ?? workspaces[0]

  return (
    <div className="relative mx-3 mt-1 mb-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] text-ink hover:bg-hover transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`workspace: ${active?.name ?? 'Personal'}`}
      >
        {active?.kind === 'org' ? (
          <Building2 className="size-3.5 shrink-0 text-ink-dim" strokeWidth={2} />
        ) : (
          <UserIcon className="size-3.5 shrink-0 text-ink-dim" strokeWidth={2} />
        )}
        <span className="truncate">{active?.name ?? 'Personal'}</span>
        <ChevronDown
          className="ml-auto size-3.5 shrink-0 text-ink-faint group-hover:text-ink-dim transition-colors"
          strokeWidth={2}
        />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label="workspaces"
          className="absolute left-0 right-0 top-9 z-40 rounded-lg border border-rule bg-elevated shadow-md py-1"
        >
          {workspaces.map((w) => {
            const isActive =
              w.workspaceId === active?.workspaceId
            return (
              <button
                key={w.workspaceId}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  // Personal entry ⇒ undefined (the back-compat path).
                  setActiveWorkspaceId(
                    w.kind === 'personal' ? undefined : w.workspaceId,
                  )
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink hover:bg-hover transition-colors"
              >
                {w.kind === 'org' ? (
                  <Building2 className="size-3.5 text-ink-dim" strokeWidth={2} />
                ) : (
                  <UserIcon className="size-3.5 text-ink-dim" strokeWidth={2} />
                )}
                <span className="truncate">{w.name}</span>
                {w.role === 'owner' && (
                  <span className="ml-1 rounded bg-hover px-1 py-px text-[9px] uppercase tracking-wider text-ink-faint">
                    owner
                  </span>
                )}
                {isActive && (
                  <Check
                    className="ml-auto size-3.5 text-accent"
                    strokeWidth={2.5}
                  />
                )}
              </button>
            )
          })}
          {/* Separator + management affordances. */}
          <div className="my-1 h-px bg-rule/60" />
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-dim hover:bg-hover transition-colors"
            onClick={() => {
              setManageOpen(true)
              setOpen(false)
            }}
          >
            <Plus className="size-3.5" strokeWidth={2} />
            <span>Create workspace</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-dim hover:bg-hover transition-colors"
            onClick={() => {
              setManageOpen(true)
              setOpen(false)
            }}
          >
            <Settings className="size-3.5" strokeWidth={2} />
            <span>Manage workspaces</span>
          </button>
        </div>
      )}

      <WorkspaceManagementDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
      />
    </div>
  )
}
