import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Copy, Check, Plus } from 'lucide-react'

// sharing-v1 1c — create/join a company (org) + show the invite code.
// Rendered above the "Company" graph scope. v1: an invite-code group.
export function OrgBar() {
  const orgs = useQuery(api.orgs.myOrgs)
  const createOrg = useMutation(api.orgs.createOrg)
  const joinOrg = useMutation(api.orgs.joinOrg)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      setName('')
      setCode('')
      setAdding(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (orgs === undefined) return null

  const form = (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Company name"
        className="rounded-md border border-rule bg-page px-2 py-1 text-[12.5px] outline-none focus:border-accent"
      />
      <button
        type="button"
        disabled={busy || !name.trim()}
        onClick={() => run(() => createOrg({ name }))}
        className="flex items-center gap-1 rounded-md bg-ink-strong px-2.5 py-1 text-[12px] font-medium text-surface disabled:opacity-50"
      >
        <Plus className="size-3" /> Create
      </button>
      <span className="text-ink-faint text-[11px]">or</span>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="invite code"
        className="w-28 rounded-md border border-rule bg-page px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
      />
      <button
        type="button"
        disabled={busy || !code.trim()}
        onClick={() => run(() => joinOrg({ inviteCode: code }))}
        className="rounded-md border border-rule px-2.5 py-1 text-[12px] text-ink-dim hover:text-ink-strong disabled:opacity-50"
      >
        Join
      </button>
    </div>
  )

  if (orgs.length === 0) {
    return (
      <div className="border-b border-rule px-4 py-3">
        <p className="text-[12px] text-ink-dim">
          You're not in a company yet — create one and invite teammates,
          or join with a code.
        </p>
        <div className="mt-2">{form}</div>
        {error && <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
      </div>
    )
  }

  return (
    <div className="border-b border-rule px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        {orgs.map((o) => (
          <span key={o.orgId} className="flex items-center gap-2">
            <span className="font-medium text-ink-strong">{o.name}</span>
            {o.inviteCode && (
              <button
                type="button"
                title="Copy invite code"
                onClick={() => {
                  void navigator.clipboard?.writeText(o.inviteCode!)
                  setCopied(o.orgId)
                  window.setTimeout(() => setCopied(null), 1500)
                }}
                className="flex items-center gap-1 rounded border border-rule px-1.5 py-0.5 font-mono text-[11px] text-ink-faint hover:text-ink-dim"
              >
                {copied === o.orgId ? (
                  <Check className="size-3" />
                ) : (
                  <Copy className="size-3" />
                )}
                {o.inviteCode}
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="ml-auto text-[11px] text-ink-faint hover:text-ink-dim"
        >
          {adding ? 'cancel' : '+ create / join another'}
        </button>
      </div>
      {adding && <div className="mt-2">{form}</div>}
      {error && <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
    </div>
  )
}
