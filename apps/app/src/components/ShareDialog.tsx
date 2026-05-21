import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { X, Copy, Check } from 'lucide-react'

// sharing-v1 1a — share a file with another user. v1 addresses the
// recipient by their workspace HANDLE (the WorkOS subject the other
// person sees as "your handle" below). A directory/email lookup is a
// later (org-layer) improvement. The owner's authority is the
// auth'd session; the handle only names who may read this file.
export function ShareDialog({
  fileId,
  fileLabel,
  onClose,
}: {
  fileId: string
  fileLabel: string
  onClose: () => void
}) {
  const me = useQuery(api.auth.whoami)
  const myOrgs = useQuery(api.orgs.myOrgs)
  const myShares = useQuery(api.atomShares.listMyShares)
  const shareAtom = useMutation(api.atomShares.shareAtom)
  const shareAtomToOrg = useMutation(api.atomShares.shareAtomToOrg)
  const unshareAtom = useMutation(api.atomShares.unshareAtom)
  const [mode, setMode] = useState<'person' | 'company'>('person')
  const [handle, setHandle] = useState('')
  const [orgId, setOrgId] = useState<string>('')
  const [permission, setPermission] = useState<'view' | 'edit'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const orgs = myOrgs ?? []
  // default the org select to the first org once loaded
  const selectedOrg = orgId || orgs[0]?.orgId || ''

  // existing grants FOR THIS FILE — so the owner can see + revoke them.
  const orgName = (id: string) =>
    orgs.find((o) => o.orgId === id)?.name ?? 'a company'
  const existing = (myShares ?? []).filter((s) => s.fileId === fileId)

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'company') {
        if (!selectedOrg) {
          setError('Create or join a company first (Graph → Company).')
          return
        }
        await shareAtomToOrg({
          fileId,
          orgId: selectedOrg as Parameters<typeof shareAtomToOrg>[0]['orgId'],
          permission,
        })
      } else {
        const grantee = handle.trim()
        if (!grantee) return
        await shareAtom({ fileId, granteeWorkspaceId: grantee, permission })
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-backdrop/40"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[92vw] rounded-xl border border-rule bg-surface p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink-strong">
            Share “{fileLabel}”
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-faint hover:text-ink-dim"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* mode: a person, or the whole company */}
        <div className="mt-4 flex overflow-hidden rounded-md border border-rule w-fit">
          {(['person', 'company'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 text-[12px] transition-colors ${
                mode === m
                  ? 'bg-ink-strong text-surface'
                  : 'text-ink-dim hover:text-ink-strong'
              }`}
            >
              {m === 'person' ? 'A person' : 'My company'}
            </button>
          ))}
        </div>

        {mode === 'person' ? (
          <>
            <label className="mt-3 block text-[12px] font-medium text-ink-dim">
              Recipient handle
            </label>
            <input
              autoFocus
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="paste their handle"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-rule bg-page px-2.5 py-1.5 font-mono text-[12.5px] text-ink-strong outline-none focus:border-accent"
            />
          </>
        ) : (
          <>
            <label className="mt-3 block text-[12px] font-medium text-ink-dim">
              Company
            </label>
            {orgs.length === 0 ? (
              <p className="mt-1 text-[12px] text-ink-dim">
                You're not in a company yet — create or join one in
                Graph → Company.
              </p>
            ) : (
              <select
                value={selectedOrg}
                onChange={(e) => setOrgId(e.target.value)}
                className="mt-1 w-full rounded-md border border-rule bg-page px-2.5 py-1.5 text-[12.5px] text-ink-strong outline-none focus:border-accent"
              >
                {orgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1 text-[11px] text-ink-faint">
              Everyone in the company will be able to see this file.
            </p>
          </>
        )}

        <div className="mt-3 flex items-center gap-2 text-[12px]">
          <span className="text-ink-dim">Permission</span>
          <div className="flex overflow-hidden rounded-md border border-rule">
            {(['view', 'edit'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPermission(p)}
                className={`px-2.5 py-1 text-[12px] transition-colors ${
                  permission === p
                    ? 'bg-ink-strong text-surface'
                    : 'text-ink-dim hover:text-ink-strong'
                }`}
              >
                {p === 'view' ? 'View only' : 'Can edit'}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="mt-3 text-[12px] text-danger" role="alert">
            {error}
          </p>
        )}

        {existing.length > 0 && (
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Already shared with
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {existing.map((s) => (
                <li
                  key={s.shareId}
                  className="flex items-center gap-2 text-[12px]"
                >
                  <span className="truncate text-ink-strong">
                    {s.granteeOrgId
                      ? `🏢 ${orgName(s.granteeOrgId)}`
                      : `👤 ${s.granteeWorkspaceId}`}
                  </span>
                  <span className="text-ink-faint">
                    {s.permission === 'edit' ? 'can edit' : 'view'}
                  </span>
                  <button
                    type="button"
                    title="Revoke"
                    onClick={() =>
                      void unshareAtom({
                        shareId: s.shareId as Id<'atomShares'>,
                      })
                    }
                    className="ml-auto text-ink-faint hover:text-danger"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          {/* Your handle — give this to someone so they can share with you */}
          {me?.workspaceId && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(me.workspaceId)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              }}
              className="flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-dim"
              title="Copy your handle so others can share with you"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'copied your handle' : 'copy my handle'}
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={
              busy ||
              (mode === 'person' ? !handle.trim() : !selectedOrg)
            }
            className="rounded-md bg-ink-strong px-3.5 py-1.5 text-[13px] font-medium text-surface disabled:opacity-50"
          >
            {busy ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  )
}
