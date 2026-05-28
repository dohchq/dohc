import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  Check,
  ChevronDown,
  Link as LinkIcon,
  Lock,
  Users,
  X,
} from 'lucide-react'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import {
  getGeneralAccessCopy,
  getShareTargetPlaceholder,
} from './shareDialogCopy'

// sharing-v1 1a — share a file with another user. v1 addresses the
// recipient by their workspace HANDLE (the WorkOS subject the other
// person sees as "your handle" below). A directory/email lookup is a
// later improvement. The owner's authority is the auth'd session; the
// handle only names who may read this file.
export function ShareDialog({
  fileId,
  fileLabel,
  onClose,
}: {
  fileId: string
  fileLabel: string
  onClose: () => void
}) {
  const activeWorkspaceId = useActiveWorkspaceId()
  const me = useQuery(api.auth.whoami)
  const myWorkspaces = useQuery(api.orgs.myWorkspaces, {})
  const myShares = useQuery(api.atomShares.listMyShares, {})
  const shareAtom = useMutation(api.atomShares.shareAtom)
  const shareAtomToOrg = useMutation(api.atomShares.shareAtomToOrg)
  const unshareAtom = useMutation(api.atomShares.unshareAtom)
  // P1 (multiplayer-and-h-followups §6.5) — within-workspace
  // access (private/restricted/workspace-default). Distinct from the
  // cross-workspace share grants below: this hides the doc from
  // peers in the SAME workspace; the grants share it with someone
  // OUTSIDE. Both can coexist on the same atom — an explicit
  // cross-workspace share overrides the within-workspace private flag
  // (the share IS the grant).
  const atomAccess = useQuery(api.atomAccess.getAtomAccessByFileId, {
    fileId,
    activeWorkspaceId,
  })
  const setAtomAccess = useMutation(api.atomAccess.setAtomAccessByFileId)
  const [generalAccessBusy, setGeneralAccessBusy] = useState(false)
  const [generalAccessOpen, setGeneralAccessOpen] = useState(false)
  const [generalAccessError, setGeneralAccessError] = useState<string | null>(
    null,
  )
  const [shareMode, setShareMode] = useState<'person' | 'workspace'>('person')
  const [handle, setHandle] = useState('')
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string>('')
  const [permission, setPermission] = useState<'view' | 'edit'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const workspaces = myWorkspaces ?? []
  const currentWorkspace = workspaces.find(
    (w) => w.workspaceId === activeWorkspaceId,
  )
  const isPersonalWorkspace =
    !activeWorkspaceId ||
    activeWorkspaceId === me?.workspaceId ||
    currentWorkspace?.kind === 'personal'
  const workspaceTargets = workspaces.filter((w) => w.kind === 'org')
  const canShareToWorkspace =
    !isPersonalWorkspace && workspaceTargets.length > 0
  const effectiveShareMode = canShareToWorkspace ? shareMode : 'person'
  const selectedWorkspaceId =
    targetWorkspaceId ||
    (!isPersonalWorkspace ? activeWorkspaceId : undefined) ||
    workspaceTargets[0]?.workspaceId ||
    ''

  // existing grants FOR THIS FILE — so the owner can see + revoke them.
  const workspaceName = (id: string) =>
    workspaces.find((w) => w.workspaceId === id)?.name ?? 'Workspace'
  const existing = (myShares ?? []).filter((s) => s.fileId === fileId)
  const generalAccess = getGeneralAccessCopy({
    isPersonalWorkspace,
    accessMode: atomAccess?.mode ?? 'private',
  })
  const canChangeGeneralAccess =
    generalAccess.canChangeGeneralAccess && !!atomAccess

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (effectiveShareMode === 'workspace') {
        if (!selectedWorkspaceId) {
          setError('Choose a workspace.')
          return
        }
        await shareAtomToOrg({
          fileId,
          orgId:
            selectedWorkspaceId as Parameters<typeof shareAtomToOrg>[0]['orgId'],
          permission,
        })
      } else {
        const grantee = handle.trim()
        if (!grantee) return
        await shareAtom({ fileId, granteeWorkspaceId: grantee, permission })
      }
      setHandle('')
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function changeGeneralAccess(next: 'restricted' | 'workspace') {
    if (!canChangeGeneralAccess || generalAccessBusy) return
    setGeneralAccessBusy(true)
    setGeneralAccessError(null)
    setGeneralAccessOpen(false)
    try {
      await setAtomAccess({
        fileId,
        activeWorkspaceId,
        mode: next === 'workspace' ? null : 'private',
      })
    } catch (e) {
      setGeneralAccessError((e as Error).message)
    } finally {
      setGeneralAccessBusy(false)
    }
  }

  function copyLink() {
    const href =
      typeof window !== 'undefined' && window.location?.href
        ? window.location.href
        : ''
    if (href) void navigator.clipboard?.writeText(href)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-backdrop/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-[min(92vw,680px)] rounded-[10px] border border-rule bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="min-w-0 text-[24px] font-medium leading-tight text-ink-strong">
            Share “{fileLabel}”
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="grid size-9 shrink-0 place-items-center rounded-full text-ink-dim transition-colors hover:bg-page hover:text-ink-strong"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-6 rounded-[6px] border border-rule bg-page px-4 py-3 focus-within:border-accent">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            {effectiveShareMode === 'person' ? (
              <input
                autoFocus
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={getShareTargetPlaceholder(isPersonalWorkspace)}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[18px] text-ink-strong outline-none placeholder:text-ink-faint"
              />
            ) : (
              <select
                value={selectedWorkspaceId}
                onChange={(e) => setTargetWorkspaceId(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[16px] text-ink-strong outline-none"
              >
                {workspaceTargets.map((w) => (
                  <option key={w.workspaceId} value={w.workspaceId}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-2">
              {canShareToWorkspace && (
                <div className="flex overflow-hidden rounded-full border border-rule bg-surface">
                  {(['person', 'workspace'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setShareMode(m)}
                      className={`px-3 py-1.5 text-[12px] font-medium transition-colors ${
                        effectiveShareMode === m
                          ? 'bg-ink-strong text-surface'
                          : 'text-ink-dim hover:text-ink-strong'
                      }`}
                    >
                      {m === 'person' ? 'Person' : 'Workspace'}
                    </button>
                  ))}
                </div>
              )}
              <select
                value={permission}
                onChange={(e) =>
                  setPermission(e.target.value as 'view' | 'edit')
                }
                className="rounded-full border border-rule bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-dim outline-none hover:text-ink-strong focus:border-accent"
              >
                <option value="view">View only</option>
                <option value="edit">Can edit</option>
              </select>
              <button
                type="button"
                onClick={submit}
                disabled={
                  busy ||
                  (effectiveShareMode === 'person'
                    ? !handle.trim()
                    : !selectedWorkspaceId)
                }
                className="rounded-full bg-ink-strong px-4 py-1.5 text-[12.5px] font-semibold text-surface transition-opacity disabled:opacity-40"
              >
                {busy ? 'Sharing...' : 'Share'}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-3 text-[12px] text-danger" role="alert">
            {error}
          </p>
        )}

        <section className="mt-7">
          <h3 className="text-[17px] font-semibold text-ink-strong">
            People with access
          </h3>
          <div className="mt-4 flex items-center gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-full bg-page text-[15px] font-semibold text-ink-strong">
              Y
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-ink-strong">
                You
              </p>
              <p className="truncate text-[13px] text-ink-dim">
                {me?.workspaceId ?? 'Your handle'}
              </p>
            </div>
            <span className="shrink-0 text-[14px] text-ink-faint">Owner</span>
          </div>

          {existing.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {existing.map((s) => (
                <li
                  key={s.shareId}
                  className="flex items-center gap-4 rounded-[6px] py-1"
                >
                  <div className="grid size-11 shrink-0 place-items-center rounded-full bg-page text-ink-dim">
                    {s.granteeOrgId ? (
                      <Users className="size-5" />
                    ) : (
                      <span className="text-[14px] font-semibold">P</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-ink-strong">
                      {s.granteeOrgId
                        ? workspaceName(s.granteeOrgId)
                        : s.granteeWorkspaceId}
                    </p>
                    <p className="truncate text-[12px] text-ink-faint">
                      {s.granteeOrgId ? 'Workspace' : 'Person'}
                    </p>
                  </div>
                  <span className="text-[13px] text-ink-dim">
                    {s.permission === 'edit' ? 'Can edit' : 'Viewer'}
                  </span>
                  <button
                    type="button"
                    title="Remove access"
                    onClick={() =>
                      void unshareAtom({
                        shareId: s.shareId as Id<'atomShares'>,
                      })
                    }
                    className="grid size-8 place-items-center rounded-full text-ink-faint transition-colors hover:bg-page hover:text-danger"
                  >
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-8">
          <h3 className="text-[17px] font-semibold text-ink-strong">
            General access
          </h3>
          <div className="mt-4 flex items-center gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-full bg-page text-ink-strong">
              {generalAccess.label === 'Restricted' ? (
                <Lock className="size-5" />
              ) : (
                <Users className="size-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="relative inline-block">
                <button
                  type="button"
                  disabled={!canChangeGeneralAccess || generalAccessBusy}
                  onClick={() => setGeneralAccessOpen((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-[5px] px-1 py-0.5 text-[15px] font-semibold text-ink-strong transition-colors enabled:hover:bg-page disabled:cursor-default"
                  aria-haspopup={canChangeGeneralAccess ? 'menu' : undefined}
                  aria-expanded={
                    canChangeGeneralAccess ? generalAccessOpen : undefined
                  }
                >
                  {generalAccess.label}
                  {canChangeGeneralAccess && <ChevronDown className="size-4" />}
                </button>
                {generalAccessOpen && canChangeGeneralAccess && (
                  <div className="absolute left-0 top-full z-10 mt-2 w-64 overflow-hidden rounded-[8px] border border-rule bg-surface p-1 shadow-xl">
                    <button
                      type="button"
                      onClick={() => void changeGeneralAccess('restricted')}
                      className="flex w-full items-start gap-3 rounded-[6px] px-3 py-2 text-left transition-colors hover:bg-page"
                    >
                      <Lock className="mt-0.5 size-4 text-ink-dim" />
                      <span>
                        <span className="block text-[13px] font-semibold text-ink-strong">
                          Restricted
                        </span>
                        <span className="block text-[11.5px] text-ink-faint">
                          Only people with access can open.
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void changeGeneralAccess('workspace')}
                      className="flex w-full items-start gap-3 rounded-[6px] px-3 py-2 text-left transition-colors hover:bg-page"
                    >
                      <Users className="mt-0.5 size-4 text-ink-dim" />
                      <span>
                        <span className="block text-[13px] font-semibold text-ink-strong">
                          Workspace
                        </span>
                        <span className="block text-[11.5px] text-ink-faint">
                          Anyone in this workspace can open.
                        </span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <p className="mt-0.5 text-[13px] text-ink-dim">
                {generalAccess.description}
              </p>
            </div>
          </div>
          {generalAccessError && (
            <p className="mt-3 text-[12px] text-danger" role="alert">
              {generalAccessError}
            </p>
          )}
        </section>

        <div className="mt-8 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-2 rounded-full border border-rule bg-surface px-5 py-2.5 text-[15px] font-semibold text-accent transition-colors hover:bg-page"
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <LinkIcon className="size-4" />
            )}
            {copied ? 'Copied link' : 'Copy link'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-accent px-7 py-2.5 text-[15px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
