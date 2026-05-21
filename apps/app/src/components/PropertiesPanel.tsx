import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  frontmatterEntries,
  applyFrontmatter,
  type FmEntry,
} from '../lib/frontmatter'

// D4.19 — Notion-style page properties. A friendly editor for the
// atom's frontmatter (the same block the `id:` lives in). Each
// property is a key + value row. `id` is system-managed (rename-
// proof address) so it renders read-only; everything else is
// editable + removable. Adding a property writes a new frontmatter
// key. The full block round-trips through js-yaml on every edit.
//
// Source of truth is the atom `body` (draft); local state is just
// the in-flight editing buffer. AtomShell remounts this per atom
// (key={effectivePath}), so the buffer is always for the open atom.

// D4.22 — these frontmatter keys have dedicated UI elsewhere and are
// NOT shown as editable properties: `id` is the rename-proof address;
// `title` is the page-title field above. Both are PRESERVED across
// property edits (re-read from the live body at commit time, so the
// title field's edits never get clobbered).
const HIDDEN_KEYS = new Set(['id', 'title'])

type Props = {
  body: string
  onChange: (nextBody: string) => void
}

export function PropertiesPanel({ body, onChange }: Props) {
  // Local buffer holds ONLY the user properties (never id/title).
  const [entries, setEntries] = useState<FmEntry[]>(() =>
    frontmatterEntries(body).filter((e) => !HIDDEN_KEYS.has(e.key)),
  )

  // Rebuild the frontmatter: preserve the hidden keys (id/title)
  // from the CURRENT body — the title field may have changed them
  // since this panel mounted — then layer the user properties on
  // top. Blank-keyed rows write nothing.
  function isReserved(key: string): boolean {
    return HIDDEN_KEYS.has(key.trim().toLowerCase())
  }

  function commit(next: FmEntry[]) {
    setEntries(next)
    const props: Record<string, string> = {}
    // Preserve the system keys (id/title) from the live body — the
    // title field may have changed them. Their VALUES are never
    // taken from a user-typed property row.
    for (const e of frontmatterEntries(body)) {
      if (HIDDEN_KEYS.has(e.key)) props[e.key] = e.value
    }
    for (const e of next) {
      const k = e.key.trim()
      // A user property keyed `id`/`title` (any case) is REJECTED —
      // those are reserved (the rename-proof address + the page
      // title field). Editing the real id via a property would
      // break every reference pointing at the page.
      if (k && !isReserved(k)) props[k] = e.value
    }
    onChange(applyFrontmatter(body, props))
  }

  function setValue(i: number, value: string) {
    commit(entries.map((e, j) => (j === i ? { ...e, value } : e)))
  }
  function setKey(i: number, key: string) {
    commit(entries.map((e, j) => (j === i ? { ...e, key } : e)))
  }
  function remove(i: number) {
    commit(entries.filter((_, j) => j !== i))
  }
  function add() {
    // Don't commit yet (empty key writes nothing) — just add a row
    // to the buffer for the user to fill in.
    setEntries([...entries, { key: '', value: '' }])
  }

  const hasAny = entries.length > 0

  return (
    <div className="vibeam-props">
      {entries.map((e, i) => {
        const reserved = isReserved(e.key)
        return (
          <div className="vibeam-props__row" key={`${i}`}>
            <input
              className={
                'vibeam-props__key' + (reserved ? ' is-reserved' : '')
              }
              value={e.key}
              placeholder="Property"
              onChange={(ev) => setKey(i, ev.target.value)}
              spellCheck={false}
            />
            {reserved ? (
              <span
                className="vibeam-props__reserved"
                title={`"${e.key.trim()}" is reserved — it's set by the title field / managed automatically. Pick a different name.`}
              >
                reserved name — not saved
              </span>
            ) : (
              <input
                className="vibeam-props__value"
                value={e.value}
                placeholder="Empty"
                onChange={(ev) => setValue(i, ev.target.value)}
                spellCheck={false}
              />
            )}
            <button
              type="button"
              className="vibeam-props__remove"
              title="Remove property"
              aria-label={`Remove property ${e.key || ''}`}
              onClick={() => remove(i)}
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          </div>
        )
      })}
      <button type="button" className="vibeam-props__add" onClick={add}>
        <Plus className="size-3" strokeWidth={2} />
        {hasAny ? 'Add property' : 'Add a property'}
      </button>
    </div>
  )
}
