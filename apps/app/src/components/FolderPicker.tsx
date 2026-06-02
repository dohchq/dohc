import { useEffect, useRef, useState } from 'react'
import { X, Check } from 'lucide-react'
import { FOLDER_COLORS } from '../lib/folderTokens'

// file-org-v1 §4.4 / D4.5b — FolderPicker popover. Modal dialog with
// icon grid + color grid + favorite toggle + clear. Triggered from
// the folder row's "···" button (RowActions in FileTree). On Done it
// calls onCommit with the chosen {icon, color, starred}; null fields
// CLEAR the corresponding decoration. The parent wires onCommit to
// api.folders.setMeta — which itself GC's the folderMetadata row
// when all three fields end up empty (atoms.ts setMeta semantic).
//
// ARIA + keyboard (R3 fold of convergent FAIL-A — focus trap):
//   • role="dialog", aria-modal="true", aria-labelledby pinned to
//     the heading id. Screen readers announce "dialog: customize <
//     folder>" on open.
//   • Escape key (anywhere) closes without committing.
//   • Click on the backdrop (outside the card) closes without
//     committing — the card itself stops propagation.
//   • Initial focus lands on the first icon button.
//   • Tab / Shift+Tab CYCLE within the dialog's focusable
//     descendants — required by WCAG 2.4.3 + WAI-ARIA APG. Without
//     this, `aria-modal="true"` lies to assistive tech (claims
//     outside is inert while keyboard users escape via Tab).
//
// Error surfacing (R3 fold of Codex FAIL-5 / indep FAIL-3): onCommit
// MAY throw; we render the error in a role="alert" region inside
// the card and keep the dialog open so the user can correct + retry.
//
// Note: the icon-grid PREVIEWS each icon TINTED in the currently-
// selected color — so the user sees the combined choice before
// committing. Default-color preview uses --color-ink-dim.

type Props = {
  path: string
  initial?: {
    icon?: string | null
    color?: string | null
    starred?: boolean
  }
  onClose: () => void
  onCommit: (next: {
    icon: string | null
    color: string | null
    starred: boolean
  }) => Promise<void>
}

export function FolderPicker({ path, initial, onClose, onCommit }: Props) {
  const [color, setColor] = useState<string | null>(initial?.color ?? null)
  // Favoriting now lives on the row's inline star, not in this picker.
  // We preserve the folder's current starred value through setMeta so
  // changing icon/color (or clearing it) never flips the favorite.
  const starred = initial?.starred ?? false
  const [busy, setBusy] = useState(false)
  // R3 fold (Codex FAIL-5 / indep FAIL-3) — error surface. When
  // onCommit throws, we display its message inside the card and
  // keep the dialog open. The error clears the next time the user
  // touches any control (any setState resets it).
  const [error, setError] = useState<string | null>(null)
  const firstButtonRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // R4 fold (indep FAIL-3) — mount tracker so a setState after the
  // dialog unmounts (user pressed Escape while a mutation is
  // in-flight) doesn't trip a React warning + doesn't try to
  // resurrect the closed dialog.
  //
  // R4b fix (user-reported: modal stuck after Done): MUST initialize
  // to `false` and set to `true` in the effect BODY (not just the
  // cleanup). React 18 Strict Mode in dev mounts → cleanup runs
  // (sets to false) → re-mounts the SAME ref object. The effect
  // body is the only place to flip it back to true on each mount.
  // Without the body-set, every Strict-Mode-re-mounted picker has
  // mountedRef.current=false permanently, and the success branch
  // skips onClose() — modal stays open, busy stays true, cursor
  // not-allowed.
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Initial focus on the first icon button so the keyboard user
  // lands inside the dialog immediately.
  useEffect(() => {
    firstButtonRef.current?.focus()
  }, [])

  // Escape key closes (gated on busy — R4 fold of indep FAIL-3);
  // Tab / Shift+Tab cycle focus WITHIN the dialog (focus-trap;
  // R3 fold of convergent FAIL-A; R4 fold of convergent FAIL-1
  // for the outside-focus fallback).
  useEffect(() => {
    function focusables(): HTMLElement[] {
      if (!cardRef.current) return []
      return Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('aria-hidden'))
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // R4 fold (indep FAIL-3): refuse to close mid-commit so
        // the mutation finishes (or fails into the error UI)
        // before the dialog unmounts.
        if (busy) {
          e.preventDefault()
          return
        }
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      // R4 fold (convergent FAIL-1 / Codex FAIL-1) — when the
      // focused element is OUTSIDE the dialog, focusing the
      // non-focusable card div was a silent no-op. Refocus the
      // first item instead (a real focusable descendant). This
      // restores the aria-modal contract even when focus leaked
      // (e.g. a screen-reader region nav, extension overlay).
      if (
        cardRef.current &&
        !cardRef.current.contains(document.activeElement)
      ) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  async function handleCommit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // folders are color-only now — always clear any stored icon
      await onCommit({ icon: null, color, starred })
      // R4b fix: onClose() calls a stable parent prop function
      // (setPickerFolder(null)) — always safe regardless of THIS
      // component's mount state. No mountedRef check needed; the
      // check was the source of the stuck-modal bug.
      onClose()
    } catch (e) {
      // R3 fold — keep the dialog open + surface the message so
      // the user can correct + retry. Mounted check here is the
      // defense for setState-on-unmounted (user dismissed via
      // Escape while the mutation was in flight).
      if (!mountedRef.current) return
      setError(
        e instanceof Error && e.message ? e.message : 'commit failed',
      )
      setBusy(false)
    }
  }

  async function handleClear() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onCommit({ icon: null, color: null, starred })
      onClose()
    } catch (e) {
      if (!mountedRef.current) return
      setError(
        e instanceof Error && e.message ? e.message : 'clear failed',
      )
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'var(--color-backdrop)' }}
      onClick={(e) => {
        // R4 fold (indep FAIL-3 / Codex FAIL-2): refuse backdrop
        // close while a commit is in flight. The dialog must
        // remain mounted so the user sees the outcome.
        if (busy) return
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        // R4 fold (Codex FAIL-1) — make the card itself focusable
        // as a last-resort fallback for the focus-trap (if no
        // focusables exist).
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-picker-title"
        className="bg-elevated border border-rule rounded-lg shadow-modal w-80 max-w-full focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
          <h2
            id="folder-picker-title"
            className="text-[13px] font-medium text-ink-strong"
          >
            Customize{' '}
            <span className="font-mono text-[12px] text-ink-dim">{path}</span>
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="close"
            className="flex size-6 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-hover transition-colors disabled:opacity-50"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Color grid — folders are distinguished by color (no icon). */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint font-medium mb-2">
              Color
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {FOLDER_COLORS.map((name, ci) => {
                // The "default" swatch maps to color=null in state
                // (no folderMetadata.color stored). Selected when
                // user explicitly picked default OR no color set.
                const isDefault = name === 'default'
                const selected = isDefault ? color === null : color === name
                return (
                  <button
                    key={name}
                    ref={ci === 0 ? firstButtonRef : undefined}
                    onClick={() => setColor(isDefault ? null : name)}
                    disabled={busy}
                    aria-pressed={selected}
                    aria-label={`color: ${name}`}
                    className={`size-6 rounded-full transition-all border-2 disabled:opacity-50 ${
                      selected
                        ? 'border-ink-strong scale-110'
                        : 'border-transparent hover:border-rule-strong'
                    }`}
                    style={{
                      background: isDefault
                        ? 'var(--color-ink-faint)'
                        : `var(--color-folder-${name})`,
                    }}
                  />
                )
              })}
            </div>
          </div>

        </div>

        {/* R3 fold (Codex FAIL-5 / indep FAIL-3) — error surface.
            role="alert" announces immediately; assertive live so
            screen readers don't queue behind the polite tree-level
            announcer. */}
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="px-4 pb-2 text-[12px]"
            style={{ color: 'var(--color-danger)' }}
          >
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-rule">
          <button
            onClick={handleClear}
            disabled={busy}
            className="text-[11.5px] text-ink-faint hover:text-danger transition-colors disabled:opacity-50"
          >
            Clear all
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1.5 text-[12px] text-ink-dim hover:text-ink hover:bg-hover rounded-md transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleCommit}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1.5 text-[12px] rounded-md transition-opacity disabled:opacity-50"
              style={{
                background: 'var(--color-accent-2)',
                color: 'var(--color-accent-foreground)',
              }}
            >
              <Check className="size-3" strokeWidth={2.4} />
              <span>Done</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
