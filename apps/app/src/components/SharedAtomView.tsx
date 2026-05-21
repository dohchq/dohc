import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { parseFrontmatter } from '../lib/frontmatter'
import { splitFrontmatter, joinFrontmatter, isHtmlPath, isHtmlAtomBody } from '../lib/atomId'
import { AtomEditor } from './AtomEditor'

// sharing-v1 1a/1b — view OR collaboratively edit an atom shared WITH
// the current user. Formulas resolve through evalFormulasShared
// (scoped) via AtomEditor's `shareId`. With a 'view' grant the editor
// is read-only; with 'edit' it autosaves through upsertSharedAtom
// using OPTIMISTIC CONCURRENCY (baseVersion) — a stale save is
// rejected with a CONFLICT the user can resolve by reloading, so a
// co-editor's work is never silently clobbered.
export function SharedAtomView({ shareId }: { shareId: Id<'atomShares'> }) {
  const shared = useQuery(api.atomShares.getSharedAtom, { shareId })
  const save = useMutation(api.atoms.upsertSharedAtom)

  // local edit buffer + the exact body we're editing against
  const [draft, setDraft] = useState<string | null>(null)
  const remoteBodyRef = useRef<string | null>(null)
  // `saving` is STATE (not a ref) so that when an in-flight save
  // resolves, the autosave effect RE-RUNS — if the user kept typing
  // during the save, `draft` now differs from the just-saved base and
  // a follow-up save is scheduled (a ref wouldn't re-trigger the
  // effect, stranding those edits — codex re-review P1).
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const canEdit = shared?.permission === 'edit'

  // First load seeds the buffer + base body. We do NOT clobber an
  // in-progress local edit on a reactive refetch (LWW v1) — a stale
  // save surfaces a conflict on write. (This component is KEYED by
  // shareId at the call site, so opening a different share remounts
  // it fresh — no stale-draft reuse across shares; codex P1.)
  useEffect(() => {
    if (!shared || draft !== null) return
    setDraft(shared.body)
    remoteBodyRef.current = shared.body
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared])

  // Debounced autosave for edit grants (content compare-and-swap).
  // `saving` in the deps means a finished save re-runs this: if
  // `draft` advanced during the in-flight save, the follow-up save
  // fires (no stranded edits).
  useEffect(() => {
    // Also bail while a non-conflict saveError is showing — otherwise
    // the saving→false re-run would re-schedule the SAME doomed save
    // every debounce (revoked/locked) in a loop (codex re-review).
    // The next user edit clears saveError (onChange) → one retry per
    // edit, never a loop.
    if (!canEdit || draft === null || conflict || saveError || saving) return
    const base = remoteBodyRef.current
    if (base === null || draft === base) return
    const body = draft
    const t = setTimeout(() => {
      setSaving(true)
      void save({ shareId, body, baseBody: base })
        .then(() => {
          remoteBodyRef.current = body // the just-written body is the new base
          setSaveError(null)
        })
        .catch((e) => {
          const msg = (e as Error).message
          // CONFLICT → the reload banner; any OTHER error (revoked
          // mid-edit, owner locked it, id-change rejected) → a visible
          // save-error so the grantee isn't silently typing into a
          // dead buffer.
          if (/CONFLICT/i.test(msg)) setConflict(true)
          else setSaveError(msg)
        })
        .finally(() => setSaving(false))
    }, 600)
    return () => clearTimeout(t)
  }, [draft, canEdit, conflict, saveError, saving, save, shareId])

  const { title, isHtml } = useMemo(() => {
    const src = draft ?? shared?.body ?? ''
    const { meta } = parseFrontmatter(src)
    return {
      title: typeof meta.title === 'string' ? meta.title : '',
      isHtml: shared
        ? isHtmlPath(shared.path) || isHtmlAtomBody(src)
        : false,
    }
  }, [draft, shared])

  if (shared === undefined) {
    return (
      <div className="grid h-full place-items-center text-ink-faint text-sm">
        loading…
      </div>
    )
  }
  if (shared === null) {
    return (
      <div className="grid h-full place-items-center px-8 text-center">
        <div className="max-w-sm">
          <p className="text-[15px] font-medium text-ink-strong">
            This shared file is no longer available
          </p>
          <p className="mt-2 text-[13px] text-ink-dim leading-relaxed">
            The owner may have stopped sharing it, deleted it, or
            renamed it. Ask them to share it again.
          </p>
        </div>
      </div>
    )
  }

  const body = draft ?? shared.body
  const { fm, rest } = splitFrontmatter(body)
  const leaf =
    shared.path.replace(/\.[a-z0-9]+$/i, '').split('/').pop() ?? shared.path

  function reloadLatest() {
    // discard the local draft + re-seed from the latest server copy
    setConflict(false)
    setSaveError(null)
    setDraft(shared!.body)
    remoteBodyRef.current = shared!.body
  }

  return (
    <div className="doc doc-editing mx-auto w-full max-w-[760px] px-6 py-8">
      <div className="vibeam-shared-banner mb-4 flex items-center gap-2 rounded-md border border-rule bg-surface px-3 py-2 text-[12px] text-ink-dim">
        <span className="font-medium text-ink-strong">Shared with you</span>
        <span className="opacity-60">·</span>
        <span>{canEdit ? 'can edit' : 'view only'}</span>
        <span className="opacity-60">·</span>
        <span className="font-mono opacity-70">{shared.fileId}</span>
      </div>

      {saveError && !conflict && (
        <div
          className="mb-4 rounded-md border border-danger/30 bg-danger/[0.07] px-3 py-2 text-[12.5px] text-ink-strong"
          role="alert"
        >
          Couldn’t save: {saveError}
        </div>
      )}

      {conflict && (
        <div
          className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[12.5px]"
          role="alert"
        >
          <span className="text-ink-strong">
            This file changed since you opened it. Your unsaved edits
            aren’t lost — but reload to continue from the latest.
          </span>
          <button
            type="button"
            onClick={reloadLatest}
            className="shrink-0 rounded-md bg-ink-strong px-2.5 py-1 text-[12px] font-medium text-surface"
          >
            Reload
          </button>
        </div>
      )}

      <input
        className="vibeam-title-field"
        value={title || leaf}
        placeholder="Untitled"
        readOnly
        spellCheck={false}
      />

      {isHtml ? (
        <>
          {canEdit && (
            <p className="mt-3 text-[12px] text-ink-dim">
              Shared HTML files are read-only here for now (rich
              rendering + editing is coming) — showing the source.
            </p>
          )}
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-rule bg-surface p-3 font-mono text-[12.5px] text-ink-strong">
            {rest}
          </pre>
        </>
      ) : (
        <AtomEditor
          key={shareId}
          value={rest}
          onChange={(next) => {
            if (canEdit && !conflict) {
              // a fresh edit clears a prior save-error → re-enables a
              // single retry (the effect's saveError gate lifts).
              if (saveError) setSaveError(null)
              setDraft(joinFrontmatter(fm, next))
            }
          }}
          shareId={shareId}
          readOnly={!canEdit || conflict}
        />
      )}
    </div>
  )
}
