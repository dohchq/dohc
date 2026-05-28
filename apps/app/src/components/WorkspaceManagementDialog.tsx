/**
 * Workspace management dialog (org-plan §9 Phase D).
 *
 * Single overlay reachable from the WorkspaceSwitcher. Combines:
 *   - Create a new org (any signed-in user).
 *   - For every org I'm a member of: rename (Owner-only), invite code
 *     (Owner-only — the link to invite teammates), member list with
 *     Owner controls (deleteOrg, removeMember, changeRole).
 *
 * Deliberately one dialog (not a routed page): every operation reads
 * `api.orgs.myWorkspaces` for the list, then `api.orgs.orgMembers` per
 * org for the per-org member list. All mutations are the Phase-A
 * Owner-gated ones (last-Owner protection happens server-side).
 */
import { useEffect, useRef, useState } from 'react'
import { useAction, useMutation, useQuery } from 'convex/react'
import {
  Plus,
  X,
  Copy,
  Trash2,
  UserCog,
  Building2,
  User as UserIcon,
  KeyRound,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspace } from '../lib/active-workspace'
import type { Id } from '../../convex/_generated/dataModel'

type Props = {
  open: boolean
  onClose: () => void
}

export function WorkspaceManagementDialog({ open, onClose }: Props) {
  // myWorkspaces carries the inviteCode field for Owner rows, so no
  // separate `myOrgs` subscription is needed (pragmatist round-2 #8).
  const workspaces = useQuery(api.orgs.myWorkspaces, {})
  // Phase E — createOrg + renameOrg go through the bridge ACTIONS so
  // the WorkOS Organization stays in sync (graceful when key unset).
  const createOrg = useAction(api.orgsBridge.createOrgWithBridge)
  const renameOrg = useAction(api.orgsBridge.renameOrgWithBridge)
  const deleteOrg = useMutation(api.orgs.deleteOrg)
  const removeMember = useMutation(api.orgs.removeMember)
  const changeRole = useMutation(api.orgs.changeRole)
  const leaveOrg = useMutation(api.orgs.leaveOrg)
  const joinOrg = useMutation(api.orgs.joinOrg)
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveWorkspace()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  // ESC to close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const orgWorkspaces = (workspaces ?? []).filter((w) => w.kind === 'org')
  const currentWorkspaceId = workspaces?.find((w) => w.kind === 'personal')
    ?.workspaceId

  async function onCreate(name: string) {
    setBusy(true)
    setErr(null)
    try {
      const { orgId } = await createOrg({ name })
      // A2 (H-2): the bridge action seeds .context/company.md + dashboard before
      // returning. setActiveWorkspaceId navigates to /w/<orgId> (R1
      // commit 3), so the user lands on the new workspace's home.
      // Closing the dialog so they see the populated workspace cleanly.
      setActiveWorkspaceId(orgId)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onJoin(code: string) {
    setBusy(true)
    setErr(null)
    try {
      const { orgId } = await joinOrg({ inviteCode: code.trim() })
      setActiveWorkspaceId(orgId)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Workspaces"
    >
      <div className="w-full max-w-xl max-h-[85vh] overflow-hidden rounded-xl border border-rule bg-panel shadow-xl">
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-rule">
          <div>
            <h2 className="text-[15px] font-semibold text-ink-strong">Workspaces</h2>
            <p className="mt-1 max-w-[29rem] text-[12px] leading-5 text-ink-dim">
              Personal stays private. Shared workspaces are for work that needs
              other people, permissions, and a separate home.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-dim hover:text-ink hover:bg-hover transition-colors"
            aria-label="close"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </header>

        <div className="max-h-[calc(85vh-88px)] overflow-y-auto">
          {err && (
            <div className="mx-5 mt-4 rounded-md border border-rule bg-hover px-3 py-2 text-[12px] text-ink-dim">
              {err}
            </div>
          )}

          <section className="px-5 py-4 border-b border-rule">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-ink-faint mb-3">
              Your workspaces
            </h3>
            {workspaces === undefined ? (
              <div className="rounded-lg border border-rule bg-elevated px-3 py-3 text-[12.5px] text-ink-dim">
                Loading…
              </div>
            ) : (
              <ul className="space-y-2">
                <li className="flex items-center gap-3 rounded-lg border border-rule bg-elevated px-3 py-3">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-ink-dim">
                    <UserIcon className="size-4" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink-strong">
                        Personal
                      </span>
                      {activeWorkspaceId === undefined && (
                        <span className="rounded bg-accent/15 px-1.5 py-px text-[9px] uppercase tracking-wider text-accent">
                          active
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-ink-dim">
                      Private by default
                    </p>
                  </div>
                  <span className="rounded bg-hover px-1.5 py-px text-[9px] uppercase tracking-wider text-ink-faint">
                    always you
                  </span>
                </li>
                {orgWorkspaces.map((w) => (
                  <OrgCard
                    key={w.workspaceId}
                    orgId={w.workspaceId as Id<'orgs'>}
                    name={w.name}
                    isActive={activeWorkspaceId === w.workspaceId}
                    isOwner={w.role === 'owner'}
                    inviteCode={w.inviteCode}
                    currentWorkspaceId={currentWorkspaceId}
                    onRename={async (name) => {
                      await renameOrg({ orgId: w.workspaceId as Id<'orgs'>, name })
                    }}
                    onLeave={async () => {
                      await leaveOrg({ orgId: w.workspaceId as Id<'orgs'> })
                      setActiveWorkspaceId(undefined) // drop the now-gone active id
                    }}
                    onDelete={async () => {
                      await deleteOrg({ orgId: w.workspaceId as Id<'orgs'> })
                      if (activeWorkspaceId === w.workspaceId) {
                        setActiveWorkspaceId(undefined)
                      }
                    }}
                    onRemove={async (memberWorkspaceId) => {
                      await removeMember({
                        orgId: w.workspaceId as Id<'orgs'>,
                        memberWorkspaceId,
                      })
                    }}
                    onChangeRole={async (memberWorkspaceId, role) => {
                      await changeRole({
                        orgId: w.workspaceId as Id<'orgs'>,
                        memberWorkspaceId,
                        role,
                      })
                    }}
                  />
                ))}
                {orgWorkspaces.length === 0 && (
                  <li className="rounded-lg border border-dashed border-rule px-3 py-3 text-[12.5px] text-ink-dim">
                    No shared workspaces yet.
                  </li>
                )}
              </ul>
            )}
          </section>

          <section className="space-y-3 px-5 py-4">
            <JoinOrgForm busy={busy} onSubmit={onJoin} />

            <div className="rounded-lg border border-rule bg-elevated/50 p-3">
              {createOpen ? (
                <CreateOrgForm
                  busy={busy}
                  onSubmit={onCreate}
                  onCancel={() => setCreateOpen(false)}
                />
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-ink-dim">
                    <Building2 className="size-4" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-ink-strong">
                      Need a separate shared space?
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-5 text-ink-dim">
                      Create one only when the work needs shared docs, members,
                      and permissions.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-hover transition-colors sm:w-auto"
                  >
                    <Plus className="size-3.5" strokeWidth={2.5} />
                    New shared workspace
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function CreateOrgForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  // F2 (ultrathink H4) — double-click ref lock. React's setState is
  // async, so `busy` doesn't synchronously gate the second click. A
  // rapid double-click could fire two `createOrgWithBridge` calls
  // before the disabled state propagates — producing duplicate Convex
  // orgs (each with a fresh unique invite code) + duplicate WorkOS
  // orgs (the externalId idempotency in the bridge dedupes those but
  // not the Convex side). The ref check is synchronous and wins.
  const inFlight = useRef(false)
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        if (inFlight.current) return
        const clean = name.trim()
        if (!clean) return
        inFlight.current = true
        try {
          await onSubmit(clean)
          setName('')
        } finally {
          inFlight.current = false
        }
      }}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-ink-dim">
          <Building2 className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-ink-strong">
            Create shared workspace
          </div>
          <p className="mt-0.5 text-[11.5px] leading-5 text-ink-dim">
            For collaborative areas with their own docs, members, and access.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name"
          disabled={busy}
          autoFocus
          className="h-10 min-w-0 rounded-md border border-rule bg-panel px-3 text-[12.5px] text-ink placeholder:text-ink-faint transition-colors focus:border-rule-strong focus:outline-none disabled:cursor-not-allowed disabled:text-ink-faint"
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          aria-busy={busy}
          className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-1.5 rounded-[7px] bg-ink-strong px-3.5 text-[12.5px] font-semibold text-surface shadow-sm transition-colors hover:bg-ink focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:cursor-not-allowed disabled:bg-hover disabled:text-ink-faint disabled:shadow-none sm:w-auto"
        >
          <Plus className="size-3.5" strokeWidth={2.5} />
          {busy ? 'Creating' : 'Create'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex h-10 w-full items-center justify-center rounded-[7px] px-3 text-[12.5px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:cursor-not-allowed disabled:text-ink-faint sm:w-auto"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function JoinOrgForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (code: string) => Promise<void>
}) {
  const [code, setCode] = useState('')
  return (
    <form
      className="rounded-lg border border-rule bg-elevated/50 p-3"
      onSubmit={async (e) => {
        e.preventDefault()
        const clean = code.trim()
        if (!clean) return
        await onSubmit(clean)
        setCode('')
      }}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-ink-dim">
          <KeyRound className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <label
            htmlFor="workspace-invite-code"
            className="text-[12.5px] font-medium text-ink-strong"
          >
            Have an invite code?
          </label>
          <p className="mt-0.5 text-[11.5px] leading-5 text-ink-dim">
            Join a workspace someone shared with you.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id="workspace-invite-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Invite code"
              disabled={busy}
              className="min-w-0 flex-1 rounded-md border border-rule bg-panel px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={busy || !code.trim()}
              className="inline-flex shrink-0 items-center justify-center rounded-md border border-rule px-3 py-2 text-[12.5px] font-medium text-ink hover:bg-hover disabled:opacity-50 transition-colors"
            >
              Join
            </button>
          </div>
        </div>
      </div>
    </form>
  )
}

function OrgCard({
  orgId,
  name,
  isActive,
  isOwner,
  inviteCode,
  currentWorkspaceId,
  onRename,
  onLeave,
  onDelete,
  onRemove,
  onChangeRole,
}: {
  orgId: Id<'orgs'>
  name: string
  isActive: boolean
  isOwner: boolean
  inviteCode: string | null
  currentWorkspaceId?: string
  onRename: (name: string) => Promise<void>
  onLeave: () => Promise<void>
  onDelete: () => Promise<void>
  onRemove: (memberWorkspaceId: string) => Promise<void>
  onChangeRole: (
    memberWorkspaceId: string,
    role: 'owner' | 'member',
  ) => Promise<void>
}) {
  const members = useQuery(api.orgs.orgMembers, { orgId })
  const [renaming, setRenaming] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [opErr, setOpErr] = useState<string | null>(null)

  async function safe(fn: () => Promise<unknown>) {
    setOpErr(null)
    try {
      await fn()
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <li className="rounded-lg border border-rule bg-elevated px-3 py-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-ink-dim">
          <Building2 className="size-4" strokeWidth={2} />
        </span>
        {renaming && isOwner ? (
          <form
            className="flex flex-1 items-center gap-1.5"
            onSubmit={async (e) => {
              e.preventDefault()
              const clean = nextName.trim()
              if (!clean || clean === name) {
                setRenaming(false)
                return
              }
              await safe(() => onRename(clean))
              setRenaming(false)
            }}
          >
            <input
              type="text"
              value={nextName}
              onChange={(e) => setNextName(e.target.value)}
              autoFocus
              className="min-w-0 flex-1 rounded border border-rule bg-panel px-2 py-1.5 text-[12.5px] text-ink focus:outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="rounded border border-rule px-2 py-1.5 text-[11.5px] text-ink hover:bg-hover transition-colors"
            >
              save
            </button>
            <button
              type="button"
              onClick={() => {
                setRenaming(false)
                setNextName(name)
              }}
              className="rounded px-2 py-1.5 text-[11.5px] text-ink-dim hover:text-ink transition-colors"
            >
              cancel
            </button>
          </form>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-ink-strong">
                  {name}
                </span>
                {isActive && (
                  <span className="rounded bg-accent/15 px-1.5 py-px text-[9px] uppercase tracking-wider text-accent">
                    active
                  </span>
                )}
                {isOwner && (
                  <button
                    type="button"
                    onClick={() => {
                      setNextName(name)
                      setRenaming(true)
                    }}
                    className="text-[11px] text-ink-faint hover:text-ink-dim transition-colors"
                  >
                    rename
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-[11.5px] text-ink-dim">
                Shared workspace
              </p>
            </div>
            <span className="rounded bg-hover px-1.5 py-px text-[9px] uppercase tracking-wider text-ink-faint">
              {isOwner ? 'owner' : 'member'}
            </span>
          </>
        )}
      </div>

      {opErr && (
        <div className="mt-2 rounded bg-hover px-2 py-1 text-[11.5px] text-ink-dim">
          {opErr}
        </div>
      )}

      {isOwner && inviteCode && (
        <div className="mt-3 flex items-center gap-2 pl-11 text-[11.5px]">
          <span className="text-ink-faint uppercase tracking-wider">invite code</span>
          <code className="rounded bg-hover px-2 py-0.5 font-mono text-ink">
            {inviteCode}
          </code>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(inviteCode)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-dim hover:text-ink hover:bg-hover transition-colors"
            title="copy invite code"
            aria-label="copy invite code"
          >
            <Copy className="size-3" strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="mt-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-ink-faint mb-1.5">
          Members
        </h4>
        {members === undefined ? (
          <div className="text-[11.5px] text-ink-dim">Loading…</div>
        ) : !members ? (
          // null ⇒ caller is no longer a member; the panel should not have
          // landed here, but render defensively rather than crash.
          <div className="text-[11.5px] text-ink-dim italic">no access</div>
        ) : (
          <ul className="space-y-1">
            {members.map((m) => {
              const isSelf = m.workspaceId === currentWorkspaceId
              return (
                <li
                  key={m.workspaceId}
                  className="flex items-center gap-2 text-[12px]"
                >
                  <UserIcon className="size-3 text-ink-dim shrink-0" strokeWidth={2} />
                  <code className="truncate font-mono text-[11px] text-ink">
                    {m.workspaceId}
                  </code>
                  <span className="text-ink-faint">{m.role}</span>
                  {isSelf && (
                    <span className="rounded bg-hover px-1.5 py-px text-[9px] uppercase tracking-wider text-ink-faint">
                      you
                    </span>
                  )}
                  {isOwner && !isSelf && (
                    <div className="ml-auto flex items-center gap-1">
                      {m.role === 'member' ? (
                        <button
                          type="button"
                          onClick={() =>
                            safe(() => onChangeRole(m.workspaceId, 'owner'))
                          }
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:text-ink hover:bg-hover transition-colors"
                          title="promote to owner"
                        >
                          <UserCog className="size-3" strokeWidth={2} />
                          promote
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            safe(() => onChangeRole(m.workspaceId, 'member'))
                          }
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:text-ink hover:bg-hover transition-colors"
                          title="demote to member"
                        >
                          demote
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => safe(() => onRemove(m.workspaceId))}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:text-red-500 hover:bg-hover transition-colors"
                        title="remove from workspace"
                        aria-label="remove member"
                      >
                        <Trash2 className="size-3" strokeWidth={2} />
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 pt-2 border-t border-rule/50 flex justify-end">
        {isOwner ? (
          <button
            type="button"
            onClick={() =>
              safe(async () => {
                if (
                  !window.confirm(
                    `Delete ${name}? This archives the workspace and removes it for every member.`,
                  )
                )
                  return
                await onDelete()
              })
            }
            className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-dim hover:text-red-500 transition-colors"
          >
            <Trash2 className="size-3" strokeWidth={2} />
            delete workspace
          </button>
        ) : (
          <button
            type="button"
            onClick={() =>
              safe(async () => {
                if (
                  !window.confirm(
                    `Leave ${name}? You'll need a fresh invite to rejoin.`,
                  )
                )
                  return
                await onLeave()
              })
            }
            className="text-[11.5px] text-ink-dim hover:text-red-500 transition-colors"
          >
            leave workspace
          </button>
        )}
      </div>
    </li>
  )
}
