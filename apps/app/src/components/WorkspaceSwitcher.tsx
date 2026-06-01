/**
 * Sidebar workspace switcher (org-plan §9 Phase D).
 *
 * Compact footer control that shows the active workspace's name. Clicking
 * opens a list of "personal + every org I'm an active member of" with a
 * checkmark on the active one. Picking an entry calls `setActiveWorkspaceId`
 * and the rest of the app reactively re-queries with the new workspaceId via
 * `useActiveWorkspaceId()`.
 *
 * `api.orgs.myWorkspaces` is the single source of truth for the list
 * (personal first, then active orgs). The active entry is matched by
 * comparing each row's `workspaceId` against the context's value
 * (undefined ⇒ personal entry).
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  Settings,
  User as UserIcon,
  Building2,
} from 'lucide-react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspace } from '../lib/active-workspace'
import { useChatBusy } from '../lib/chat-busy'
import { WorkspaceManagementDialog } from './WorkspaceManagementDialog'

const MENU_EDGE_GAP = 12
const MENU_TRIGGER_GAP = 8

type WorkspaceMenuFrame = {
  left: number
  bottom: number
  width: number
  maxHeight: number
}

function menuFrameForTrigger(
  rect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): WorkspaceMenuFrame {
  const width = Math.max(196, Math.min(rect.width, viewportWidth - MENU_EDGE_GAP * 2))
  const maxLeft = Math.max(MENU_EDGE_GAP, viewportWidth - width - MENU_EDGE_GAP)
  const left = Math.round(Math.min(Math.max(MENU_EDGE_GAP, rect.left), maxLeft))
  const availableAbove = Math.max(160, rect.top - MENU_EDGE_GAP - MENU_TRIGGER_GAP)

  return {
    left,
    bottom: Math.round(viewportHeight - rect.top + MENU_TRIGGER_GAP),
    width: Math.round(width),
    maxHeight: Math.round(availableAbove),
  }
}

export function WorkspaceSwitcher() {
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveWorkspace()
  const workspaces = useQuery(api.orgs.myWorkspaces, {})
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [menuFrame, setMenuFrame] = useState<WorkspaceMenuFrame | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // F1 — block the switcher while a chat stream is mid-flight. Without
  // this, navigating mid-send (R1 commit 3 → setActiveWorkspaceId
  // navigates) rebinds the chat to the new workspace's thread and
  // orphans the in-flight assistant tokens. v1 disables the button +
  // tooltip; v2 (deferred) is the full abandon-confirm + AbortController.
  const chatBusy = useChatBusy()

  function updateMenuFrame() {
    if (typeof window === 'undefined') return
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuFrame(menuFrameForTrigger(rect, window.innerWidth, window.innerHeight))
  }

  // Click-outside to close. The menu is portalled so it can escape the
  // sidebar's overflow clipping while still behaving like a local popover.
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      const path =
        typeof event.composedPath === 'function' ? event.composedPath() : []
      if (
        !(
          popoverRef.current &&
          (popoverRef.current.contains(target) || path.includes(popoverRef.current))
        ) &&
        !(
          buttonRef.current &&
          (buttonRef.current.contains(target) || path.includes(buttonRef.current))
        )
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updateMenuFrame()
    window.addEventListener('resize', updateMenuFrame)
    window.addEventListener('scroll', updateMenuFrame, true)
    return () => {
      window.removeEventListener('resize', updateMenuFrame)
      window.removeEventListener('scroll', updateMenuFrame, true)
    }
  }, [open])

  // Self-heal: if the persisted activeWorkspaceId points at an org the
  // caller is NOT (or no longer) a member of, reset to personal so the
  // sidebar doesn't get stuck on a workspace whose queries all reject.
  // MUST run before any early return — React Rules of Hooks require the
  // hook order to be stable across renders, and the loading branch
  // below is a render-conditional early return.
  const known = workspaces?.find((w) => w.workspaceId === activeWorkspaceId)
  const isStale =
    workspaces !== undefined && activeWorkspaceId !== undefined && !known
  useEffect(() => {
    if (isStale) setActiveWorkspaceId(undefined)
  }, [isStale, setActiveWorkspaceId])

  // Loading: render a stable empty button-frame (no skeleton churn).
  if (workspaces === undefined) {
    return (
      <div
        className="mx-3 mb-1 h-8 rounded-md bg-hover/40"
        aria-hidden
      />
    )
  }

  // Resolve the row to display. undefined activeWorkspaceId ⇒ personal
  // (which myWorkspaces always returns first).
  const active =
    activeWorkspaceId === undefined
      ? workspaces[0]
      : known ?? workspaces[0]

  const menu =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            aria-label="workspaces"
            className="fixed z-50 overflow-y-auto rounded-xl border border-rule-strong bg-elevated p-1 shadow-modal"
            style={{
              left: menuFrame?.left ?? MENU_EDGE_GAP,
              bottom: menuFrame?.bottom ?? 72,
              width: menuFrame?.width ?? 220,
              maxHeight: menuFrame?.maxHeight ?? 320,
            }}
          >
            {workspaces.map((w) => {
              const isActive = w.workspaceId === active?.workspaceId
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
                  className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] transition-colors ${
                    isActive
                      ? 'bg-hover text-ink-strong'
                      : 'text-ink-dim hover:bg-hover hover:text-ink'
                  }`}
                >
                  {w.kind === 'org' ? (
                    <Building2 className="size-3.5 shrink-0 text-ink-dim" strokeWidth={2} />
                  ) : (
                    <UserIcon className="size-3.5 shrink-0 text-ink-dim" strokeWidth={2} />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{w.name}</span>
                  {w.role === 'owner' && (
                    <span className="rounded-md border border-rule bg-panel px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                      owner
                    </span>
                  )}
                  {isActive && (
                    <Check
                      className="size-3.5 shrink-0 text-accent"
                      strokeWidth={2.5}
                    />
                  )}
                </button>
              )
            })}
            <div className="my-1 h-px bg-rule/60" />
            <button
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
              onClick={() => {
                setManageOpen(true)
                setOpen(false)
              }}
            >
              <Settings className="size-3.5 shrink-0" strokeWidth={2} />
              <span className="truncate">Manage workspaces</span>
            </button>
          </div>,
          document.body,
        )
      : null

  return (
    <div className="mx-3 mb-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          updateMenuFrame()
          setOpen((v) => !v)
        }}
        disabled={chatBusy}
        className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] font-medium text-ink-dim transition-[background,color] hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={chatBusy}
        title={
          chatBusy
            ? 'dohc is sending a message — wait for it to finish before switching workspaces.'
            : `workspace: ${active?.name ?? 'Personal'}`
        }
      >
        {active?.kind === 'org' ? (
          <Building2 className="size-3.5 shrink-0 text-ink-faint transition-colors group-hover:text-ink-dim" strokeWidth={2} />
        ) : (
          <UserIcon className="size-3.5 shrink-0 text-ink-faint transition-colors group-hover:text-ink-dim" strokeWidth={2} />
        )}
        <span className="min-w-0 flex-1 truncate text-ink-dim transition-colors group-hover:text-ink">
          {active?.name ?? 'Personal'}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-ink-faint transition-[color,transform] group-hover:text-ink-dim ${
            open ? 'rotate-180' : ''
          }`}
          strokeWidth={2}
        />
      </button>
      {menu}

      <WorkspaceManagementDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
      />
    </div>
  )
}
