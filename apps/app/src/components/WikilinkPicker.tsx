import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { TextSelection } from '@tiptap/pm/state'
import type { WikilinkFile } from './wikilinkPlugin'

// D4.8b — autocomplete popover for the `[[` trigger.
//
// Renders a floating list of matching files at the editor's cursor
// position. The wikilinkPlugin tracks the autocomplete state +
// pushes it here via a setState callback. The picker filters the
// file list against the current query (case-insensitive substring
// match on path + title), supports arrow/enter/escape keyboard
// nav, and dispatches a transaction back into the editor on
// selection.
//
// Positioning: relies on the editor view's `coordsAtPos` to place
// the popover just below the cursor. The view is passed in via
// ref; the popover re-reads coords on every state change.

export type WikilinkPickerState =
  | { open: false }
  | {
      open: true
      from: number
      query: string
    }

type Props = {
  state: WikilinkPickerState
  files: ReadonlyArray<WikilinkFile>
  /** ProseMirror EditorView — used for coordsAtPos + dispatch. */
  view: {
    coordsAtPos(pos: number): { left: number; top: number; bottom: number }
    state: {
      tr: {
        replaceWith(from: number, to: number, content: unknown): unknown
        insertText(text: string, from?: number, to?: number): unknown
        setSelection(s: unknown): unknown
      }
      schema: { text(s: string): unknown }
      selection: { from: number }
    }
    dispatch(tr: unknown): void
    focus(): void
  } | null
  onDismiss: () => void
}

export function WikilinkPicker({ state, files, view, onDismiss }: Props) {
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // D4.8d — refs to each item button so the active one can scroll
  // itself into the picker's scrollable area when keyboard nav
  // moves past the visible window.
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Reset selection when query changes.
  useEffect(() => {
    setActiveIdx(0)
  }, [state.open ? state.query : ''])

  // D4.8d — keep the active item visible. `block: 'nearest'`
  // scrolls only if the item is outside the current viewport
  // (otherwise no-op), so it doesn't fight with hover/manual
  // scrolling.
  useEffect(() => {
    if (!state.open) return
    const el = itemRefs.current[activeIdx]
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, state.open])

  // Filtered + ranked results.
  const matches = useMemo(() => {
    if (!state.open) return []
    const q = state.query.toLowerCase().trim()
    const scored = files.map((f) => {
      const path = f.path.replace(/\.md$/i, '').toLowerCase()
      const title = (f.title ?? '').toLowerCase()
      // Score: lower is better.
      // - exact prefix of leaf: 0
      // - leaf contains: 1
      // - path contains: 2
      // - title contains: 3
      // - no match: -1
      if (q === '') return { f, score: 4 } // empty query — all match
      const leaf = path.split('/').pop() ?? path
      if (leaf.startsWith(q)) return { f, score: 0 }
      if (leaf.includes(q)) return { f, score: 1 }
      if (path.includes(q)) return { f, score: 2 }
      if (title.includes(q)) return { f, score: 3 }
      return { f, score: -1 }
    })
    return scored
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.f.path.localeCompare(b.f.path))
      .slice(0, 12)
      .map((x) => x.f)
  }, [state.open ? state.query : '', files, state.open])

  function commit(file: WikilinkFile) {
    if (!view || !state.open) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = view as any
    const cursorPos = v.state.selection.from
    const pathNoExt = file.path.replace(/\.md$/i, '')
    const insert = `[[${pathNoExt}]]`
    const tr = v.state.tr.replaceWith(
      state.from,
      cursorPos,
      v.state.schema.text(insert),
    )
    // D4.8c — explicitly set the selection to the position RIGHT
    // AFTER the inserted `]]`. Without this, PM's default
    // selection mapping can leave the cursor inside the new
    // wikilink range, where the hide-text decoration collapses
    // its visual height to 0 (cursor becomes invisible).
    const afterInsert = state.from + insert.length
    tr.setSelection(TextSelection.near(tr.doc.resolve(afterInsert)))
    v.dispatch(tr)
    v.focus()
    onDismiss()
  }

  // Keyboard handling — attached to the WINDOW (not the editor)
  // because the editor consumes most keys. We capture in the
  // capture phase so we run BEFORE the editor's own keymap.
  useEffect(() => {
    if (!state.open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onDismiss()
        return
      }
      if (matches.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIdx((i) => (i + 1) % matches.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIdx((i) => (i - 1 + matches.length) % matches.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const sel = matches[activeIdx]
        if (sel) commit(sel)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state.open, matches, activeIdx, onDismiss, view, state])

  // Position: read coords from the view at the opening `[`.
  const coords = state.open && view
    ? (() => {
        try {
          return view.coordsAtPos(state.from)
        } catch {
          return null
        }
      })()
    : null

  if (!state.open || !coords) return null

  return (
    <div
      className="dohc-wikilink-picker"
      style={{
        position: 'fixed',
        left: coords.left,
        top: coords.bottom + 4,
        zIndex: 60,
      }}
      // Prevent click-through from stealing focus from the editor.
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.length === 0 ? (
        <div className="dohc-wikilink-picker__empty">
          No files match "{state.query}"
        </div>
      ) : (
        <div ref={listRef}>
          {matches.map((f, i) => {
            const display =
              (f.title ?? '').trim() ||
              (f.path.replace(/\.md$/i, '').split('/').pop() ?? f.path)
            const subpath = f.path.replace(/\.md$/i, '')
            return (
              <button
                key={f.path}
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                className={
                  'dohc-wikilink-picker__item' +
                  (i === activeIdx ? ' is-active' : '')
                }
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(f)}
              >
                <FileText
                  className="size-3.5 shrink-0 opacity-60"
                  strokeWidth={1.8}
                />
                <span className="dohc-wikilink-picker__item-title">
                  {display}
                </span>
                <span className="dohc-wikilink-picker__item-path">
                  {subpath}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
