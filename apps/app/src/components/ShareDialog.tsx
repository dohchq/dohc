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
  getGeneralAccessOptions,
  type GeneralAccessValue,
  getShareTargetPlaceholder,
} from './shareDialogCopy'

// sharing-v1 1a — share a file with another user. The UI accepts an
// email address, then the server resolves it through the signed-in
// profile directory to the recipient's workspace id before granting
// access. The owner's authority is still the auth'd session.
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
  const myShares = useQuery(api.atomShares.listMyShares, { activeWorkspaceId })
  const shareAtomByEmail = useMutation(api.atomShares.shareAtomByEmail)
  const shareAtomToOrg = useMutation(api.atomShares.shareAtomToOrg)
  const shareAtomPublic = useMutation(api.atomShares.shareAtomPublic)
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
  const [email, setEmail] = useState('')
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string>('')
  const [permission, setPermission] = useState<'view' | 'edit'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [publicShareOverride, setPublicShareOverride] = useState<
    Id<'atomShares'> | null | undefined
  >(undefined)

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
  const publicShare = existing.find((s) => s.publicAccess === true)
  const namedShares = existing.filter((s) => s.publicAccess !== true)
  const publicShareId =
    publicShareOverride === undefined
      ? (publicShare?.shareId as Id<'atomShares'> | undefined)
      : (publicShareOverride ?? undefined)
  const hasPublicLink = !!publicShareId
  const generalAccess = getGeneralAccessCopy({
    isPersonalWorkspace,
    accessMode: atomAccess?.mode ?? 'private',
    hasPublicLink,
  })
  const generalAccessValue: GeneralAccessValue = hasPublicLink
    ? 'link'
    : !isPersonalWorkspace && atomAccess?.mode === 'org-default'
      ? 'workspace'
      : 'restricted'
  const generalAccessOptions = getGeneralAccessOptions(isPersonalWorkspace)
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
          activeWorkspaceId,
        })
      } else {
        const granteeEmail = email.trim()
        if (!granteeEmail) return
        await shareAtomByEmail({
          fileId,
          email: granteeEmail,
          permission,
          activeWorkspaceId,
        })
      }
      setEmail('')
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function changeGeneralAccess(next: GeneralAccessValue) {
    if (!canChangeGeneralAccess || generalAccessBusy) return
    setGeneralAccessBusy(true)
    setGeneralAccessError(null)
    setGeneralAccessOpen(false)
    try {
      if (next === 'link') {
        const shareId = await shareAtomPublic({
          fileId,
          activeWorkspaceId,
          permission: 'view',
        })
        setPublicShareOverride(shareId as Id<'atomShares'>)
        return
      }

      if (publicShareId) {
        await unshareAtom({ shareId: publicShareId, activeWorkspaceId })
        setPublicShareOverride(null)
      }

      if (!isPersonalWorkspace) {
        await setAtomAccess({
          fileId,
          activeWorkspaceId,
          mode: next === 'workspace' ? null : 'private',
        })
      }
    } catch (e) {
      setGeneralAccessError((e as Error).message)
    } finally {
      setGeneralAccessBusy(false)
    }
  }

  function copyLink() {
    const href = (() => {
      if (typeof window === 'undefined' || !window.location?.origin) return ''
      if (publicShareId) {
        return `${window.location.origin}/w/me/shared/${encodeURIComponent(publicShareId)}`
      }
      return window.location.href
    })()
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
        className="w-[min(92vw,560px)] rounded-[10px] border border-rule bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="min-w-0 text-[21px] font-medium leading-tight text-ink-strong">
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

        <div className="mt-5 rounded-[7px] border border-rule bg-page/70 px-3 py-2.5 focus-within:border-accent">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {effectiveShareMode === 'person' ? (
              <input
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={getShareTargetPlaceholder(isPersonalWorkspace)}
                type="email"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-strong outline-none placeholder:text-ink-faint"
              />
            ) : (
              <select
                value={selectedWorkspaceId}
                onChange={(e) => setTargetWorkspaceId(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-strong outline-none"
              >
                {workspaceTargets.map((w) => (
                  <option key={w.workspaceId} value={w.workspaceId}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            <div className="flex shrink-0 items-center justify-end gap-2">
              {canShareToWorkspace && (
                <div className="flex overflow-hidden rounded-full border border-rule bg-surface/90">
                  {(['person', 'workspace'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setShareMode(m)}
                      className={`px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
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
                className="rounded-full border border-rule bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-dim outline-none hover:text-ink-strong focus:border-accent"
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
                    ? !email.trim()
                    : !selectedWorkspaceId)
                }
                className="rounded-full bg-ink-strong px-3.5 py-1 text-[12px] font-semibold text-surface transition-opacity disabled:opacity-40"
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

        <section className="mt-6">
          <h3 className="text-[15px] font-semibold text-ink-strong">
            People with access
          </h3>
          <div className="mt-3 grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-full bg-page text-[13px] font-semibold text-ink-strong">
              Y
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold text-ink-strong">
                You
              </p>
              <p className="truncate text-[12px] text-ink-dim">
                {me?.email ?? me?.workspaceId ?? 'Your email'}
              </p>
            </div>
            <span className="shrink-0 text-[12.5px] text-ink-faint">Owner</span>
          </div>

          {namedShares.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {namedShares.map((s) => (
                <li
                  key={s.shareId}
                  className="grid grid-cols-[36px_minmax(0,1fr)_auto_32px] items-center gap-3 rounded-[6px] py-1"
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-full bg-page text-ink-dim">
                    {s.granteeOrgId ? (
                      <Users className="size-4" />
                    ) : (
                      <span className="text-[12px] font-semibold">P</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink-strong">
                      {s.granteeOrgId
                        ? workspaceName(s.granteeOrgId)
                        : (s.granteeName ??
                          s.granteeEmail ??
                          s.granteeWorkspaceId)}
                    </p>
                    <p className="truncate text-[11.5px] text-ink-faint">
                      {s.granteeOrgId
                        ? 'Workspace'
                        : (s.granteeEmail ?? 'Person')}
                    </p>
                  </div>
                  <span className="text-[12px] text-ink-dim">
                    {s.permission === 'edit' ? 'Can edit' : 'Viewer'}
                  </span>
                  <button
                    type="button"
                    title="Remove access"
                    onClick={() =>
                      void unshareAtom({
                        shareId: s.shareId as Id<'atomShares'>,
                        activeWorkspaceId,
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

        <section className="mt-6">
          <h3 className="text-[15px] font-semibold text-ink-strong">
            General access
          </h3>
          <div className="mt-3 grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-full bg-page text-ink-strong">
              {generalAccess.label === 'Restricted' ? (
                <Lock className="size-4" />
              ) : generalAccess.label === 'Anyone with the link' ? (
                <LinkIcon className="size-4" />
              ) : (
                <Users className="size-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="relative inline-block">
                <button
                  type="button"
                  disabled={!canChangeGeneralAccess || generalAccessBusy}
                  onClick={() => setGeneralAccessOpen((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-[5px] py-0.5 pl-0 pr-1 text-[13.5px] font-semibold text-ink-strong transition-colors enabled:hover:bg-page disabled:cursor-default"
                  aria-haspopup={canChangeGeneralAccess ? 'menu' : undefined}
                  aria-expanded={
                    canChangeGeneralAccess ? generalAccessOpen : undefined
                  }
                >
                  {generalAccess.label}
                  {canChangeGeneralAccess && <ChevronDown className="size-4" />}
                </button>
                {generalAccessOpen && canChangeGeneralAccess && (
                  <div className="absolute left-0 top-full z-10 mt-2 w-[280px] overflow-hidden rounded-[8px] border border-rule bg-surface p-1 shadow-xl">
                    {generalAccessOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => void changeGeneralAccess(option.value)}
                        className={`flex w-full items-start gap-3 rounded-[6px] px-3 py-2 text-left transition-colors hover:bg-page ${
                          generalAccessValue === option.value ? 'bg-page' : ''
                        }`}
                      >
                        {option.value === 'restricted' ? (
                          <Lock className="mt-0.5 size-4 text-ink-dim" />
                        ) : option.value === 'link' ? (
                          <LinkIcon className="mt-0.5 size-4 text-ink-dim" />
                        ) : (
                          <Users className="mt-0.5 size-4 text-ink-dim" />
                        )}
                        <span>
                          <span className="block text-[12.5px] font-semibold text-ink-strong">
                            {option.label}
                          </span>
                          <span className="block text-[11px] text-ink-faint">
                            {option.description}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="mt-0.5 text-[12px] text-ink-dim">
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

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-2 rounded-full border border-rule bg-surface px-4 py-2 text-[13px] font-semibold text-accent transition-colors hover:bg-page"
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
            className="rounded-full bg-accent px-6 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
