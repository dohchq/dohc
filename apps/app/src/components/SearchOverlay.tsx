import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { Search, FileText, Globe, Sparkles, Star, SquareTerminal } from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { normalizeQuery } from '../../convex/searchText'
import { SidebarRowsSkeleton } from './Skeleton'

function ResultIcon({ type }: { type: 'html' | 'skill' | 'command' | null }) {
  if (type === 'html')
    return <Globe className="size-3.5 shrink-0 text-ink-faint" strokeWidth={2} />
  if (type === 'skill')
    return (
      <Sparkles className="size-3.5 shrink-0 text-violet-500" strokeWidth={2} />
    )
  if (type === 'command')
    return (
      <SquareTerminal
        className="size-3.5 shrink-0 text-accent"
        strokeWidth={2}
      />
    )
  return <FileText className="size-3.5 shrink-0 text-ink-faint" strokeWidth={2} />
}

/**
 * Dedicated full-content search (⌘⇧F). Searches every page by title and
 * content — markdown, HTML visible text, and ASCII sketches — via the
 * workspace-scoped api.search.run query. Empty query shows recent pages.
 */
export function SearchOverlay({
  open,
  onClose,
  onOpenAtom,
}: {
  open: boolean
  onClose: () => void
  onOpenAtom: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const ensureIndexed = useMutation(api.search.ensureIndexed)

  // Reset + focus on open.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setDebounced('')
    setCursor(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    // Self-heal: kick off a workspace-scoped backfill once per browser
    // so a workspace whose atoms predate the search feature doesn't show
    // a silently empty result on first use. Idempotent on the server.
    try {
      if (window.localStorage.getItem('dohc-search-indexed') !== '1') {
        void ensureIndexed({})
        window.localStorage.setItem('dohc-search-indexed', '1')
      }
    } catch {
      // localStorage unavailable / quota — non-fatal.
    }
    return () => window.clearTimeout(id)
  }, [open, ensureIndexed])

  // Debounce the query feeding the reactive search.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 140)
    return () => window.clearTimeout(id)
  }, [query])

  const searchResult = useQuery(
    api.search.run,
    open ? { query: debounced } : 'skip',
  )
  const results = searchResult ?? []
  const searchLoading = open && searchResult === undefined
  // Mirror the server's branch: < 2 normalized terms ⇒ recent-docs mode
  // (so "???" reads as Recent here too, matching what the server returns).
  const isRecent = normalizeQuery(debounced).length < 2

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, results.length - 1)))
  }, [results.length])

  if (!open) return null

  const choose = (path: string) => {
    onOpenAtom(path)
    onClose()
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] bg-backdrop backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-[600px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-rule-strong bg-elevated shadow-modal"
      >
        <div className="flex items-center gap-2.5 border-b border-rule px-4">
          <Search
            className="size-4 shrink-0 text-ink-faint"
            strokeWidth={2}
            aria-hidden
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all pages by title or content…"
            aria-label="Search pages"
            className="h-11 flex-1 border-none bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.max(0, Math.min(results.length - 1, c + 1)))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(0, c - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const r = results[cursor]
                if (r) choose(r.path)
              }
            }}
          />
          <kbd className="rounded border border-rule px-1.5 py-0.5 text-[10.5px] font-medium text-ink-faint">
            esc
          </kbd>
        </div>

        {isRecent && results.length > 0 && (
          <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            Recent
          </div>
        )}

        <div className="max-h-[420px] overflow-y-auto py-1.5">
          {searchLoading ? (
            <SidebarRowsSkeleton rows={5} className="px-2" />
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">
              {isRecent ? 'No pages yet.' : 'No matches.'}
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.path}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(r.path)}
                className={`relative flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors ${
                  i === cursor ? 'bg-hover' : 'hover:bg-hover'
                }`}
              >
                {i === cursor && (
                  <span className="absolute left-0 top-2.5 h-5 w-0.5 rounded-r bg-ink-strong" />
                )}
                <span className="flex min-w-0 items-center gap-2">
                  <ResultIcon type={r.type} />
                  <span className="truncate text-[13px] font-medium text-ink-strong">
                    {r.title}
                  </span>
                  {r.starred && (
                    <Star
                      className="size-3 shrink-0 fill-current text-accent-2"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  )}
                  <span className="ml-auto max-w-[40%] shrink-0 truncate font-mono text-[10.5px] text-ink-faint">
                    {r.path}
                  </span>
                </span>
                {!isRecent && r.snippet.length > 0 && (
                  <span className="block truncate pl-[22px] text-[11.5px] leading-snug text-ink-dim">
                    {r.snippet.map((p, j) =>
                      p.hit ? (
                        <span key={j} className="font-semibold text-ink-strong">
                          {p.s}
                        </span>
                      ) : (
                        <span key={j}>{p.s}</span>
                      ),
                    )}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-rule bg-panel px-4 py-2">
          {[
            ['↑↓', 'navigate'],
            ['⏎', 'open'],
            ['esc', 'close'],
          ].map(([k, label]) => (
            <span key={label} className="flex items-center gap-1 text-[10px] text-ink-faint">
              <kbd className="rounded border border-rule bg-elevated px-1.5 py-0.5 font-medium">
                {k}
              </kbd>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
