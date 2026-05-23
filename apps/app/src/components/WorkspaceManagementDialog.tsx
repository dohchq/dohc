/**
 * Workspace management dialog (org-plan §9 Phase D).
 *
 * Single overlay reachable from the WorkspaceSwitcher. Combines:
 *   - Create a new org (any signed-in user).
 *   - For every org I'm a member of: rename (Owner-only), invite code
 *     (Owner-only — the link to invite teammates), member list with
 *     Owner controls (removeMember, changeRole).
 *
 * Deliberately one dialog (not a routed page): every operation reads
 * `api.orgs.myWorkspaces` for the list, then `api.orgs.orgMembers` per
 * org for the per-org member list. All mutations are the Phase-A
 * Owner-gated ones (last-Owner protection happens server-side).
 */
import { useEffect, useState } from 'react'
import { useAction, useMutation, useQuery } from 'convex/react'
import { Plus, X, Copy, Trash2, UserCog, Building2, User as UserIcon } from 'lucide-react'
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
  const removeMember = useMutation(api.orgs.removeMember)
  const changeRole = useMutation(api.orgs.changeRole)
  const leaveOrg = useMutation(api.orgs.leaveOrg)
  const joinOrg = useMutation(api.orgs.joinOrg)
  const { setActiveWorkspaceId } = useActiveWorkspace()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

  async function onCreate(name: string) {
    setBusy(true)
    setErr(null)
    try {
      const { orgId } = await createOrg({ name })
      // Auto-switch to the new org so the user immediately sees their
      // (empty) workspace.
      setActiveWorkspaceId(orgId)
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
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg border border-rule bg-panel shadow-xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-rule">
          <h2 className="text-[15px] font-semibold text-ink-strong">Workspaces</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim hover:text-ink hover:bg-hover transition-colors"
            aria-label="close"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </header>

        {err && (
          <div className="mx-5 mt-4 rounded-md border border-rule bg-hover px-3 py-2 text-[12px] text-ink-dim">
            {err}
          </div>
        )}

        <section className="px-5 py-4 border-b border-rule">
          <h3 className="text-[12px] font-medium uppercase tracking-wider text-ink-faint mb-3">
            Create or join
          </h3>
          <CreateOrgForm busy={busy} onSubmit={onCreate} />
          <div className="mt-3">
            <JoinOrgForm busy={busy} onSubmit={onJoin} />
          </div>
        </section>

        <section className="px-5 py-4">
          <h3 className="text-[12px] font-medium uppercase tracking-wider text-ink-faint mb-3">
            Your workspaces
          </h3>
          {workspaces === undefined ? (
            <div className="text-[12.5px] text-ink-dim">Loading…</div>
          ) : (
            <ul className="space-y-3">
              {/* Personal always-on, no controls. */}
              <li className="flex items-center gap-2 text-[12.5px] text-ink">
                <UserIcon className="size-3.5 text-ink-dim" strokeWidth={2} />
                <span>Personal</span>
                <span className="ml-2 rounded bg-hover px-1.5 py-px text-[9px] uppercase tracking-wider text-ink-faint">
                  always you
                </span>
              </li>
              {orgWorkspaces.map((w) => (
                <OrgCard
                  key={w.workspaceId}
                  orgId={w.workspaceId as Id<'orgs'>}
                  name={w.name}
                  isOwner={w.role === 'owner'}
                  inviteCode={w.inviteCode}
                  onRename={async (name) => {
                    await renameOrg({ orgId: w.workspaceId as Id<'orgs'>, name })
                  }}
                  onLeave={async () => {
                    await leaveOrg({ orgId: w.workspaceId as Id<'orgs'> })
                    setActiveWorkspaceId(undefined) // drop the now-gone active id
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
                <li className="text-[12.5px] text-ink-dim italic">
                  No orgs yet — create one above or paste an invite code.
                </li>
              )}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function CreateOrgForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const clean = name.trim()
        if (!clean) return
        await onSubmit(clean)
        setName('')
      }}
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New workspace name (e.g. Acme Inc)"
        disabled={busy}
        className="flex-1 rounded-md border border-rule bg-elevated px-3 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-ink-on-accent hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        <Plus className="size-3.5" strokeWidth={2.5} />
        Create
      </button>
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
      className="flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const clean = code.trim()
        if (!clean) return
        await onSubmit(clean)
        setCode('')
      }}
    >
      <input
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Paste invite code"
        disabled={busy}
        className="flex-1 rounded-md border border-rule bg-elevated px-3 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint font-mono focus:outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy || !code.trim()}
        className="inline-flex items-center rounded-md border border-rule px-3 py-1.5 text-[12.5px] text-ink hover:bg-hover disabled:opacity-50 transition-colors"
      >
        Join
      </button>
    </form>
  )
}

function OrgCard({
  orgId,
  name,
  isOwner,
  inviteCode,
  onRename,
  onLeave,
  onRemove,
  onChangeRole,
}: {
  orgId: Id<'orgs'>
  name: string
  isOwner: boolean
  inviteCode: string | null
  onRename: (name: string) => Promise<void>
  onLeave: () => Promise<void>
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
    <li className="rounded-md border border-rule p-3">
      <div className="flex items-center gap-2">
        <Building2 className="size-3.5 text-ink-dim shrink-0" strokeWidth={2} />
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
              className="flex-1 rounded border border-rule bg-elevated px-2 py-1 text-[12.5px] text-ink focus:outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="rounded border border-rule px-2 py-1 text-[11.5px] text-ink hover:bg-hover transition-colors"
            >
              save
            </button>
            <button
              type="button"
              onClick={() => {
                setRenaming(false)
                setNextName(name)
              }}
              className="rounded px-2 py-1 text-[11.5px] text-ink-dim hover:text-ink transition-colors"
            >
              cancel
            </button>
          </form>
        ) : (
          <>
            <span className="text-[13px] font-medium text-ink-strong">{name}</span>
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
            <span className="ml-auto rounded bg-hover px-1.5 py-px text-[9px] uppercase tracking-wider text-ink-faint">
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
        <div className="mt-3 flex items-center gap-2 text-[11.5px]">
          <span className="text-ink-faint uppercase tracking-wider">invite</span>
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
            {members.map((m) => (
              <li
                key={m.workspaceId}
                className="flex items-center gap-2 text-[12px]"
              >
                <UserIcon className="size-3 text-ink-dim shrink-0" strokeWidth={2} />
                <code className="truncate font-mono text-[11px] text-ink">
                  {m.workspaceId}
                </code>
                <span className="text-ink-faint">{m.role}</span>
                {isOwner && (
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
                      title="remove from org"
                      aria-label="remove member"
                    >
                      <Trash2 className="size-3" strokeWidth={2} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 pt-2 border-t border-rule/50 flex justify-end">
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
      </div>
    </li>
  )
}
