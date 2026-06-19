import { useEffect, useState } from 'react'
import { Loader2, Pencil, X } from 'lucide-react'
import type { DohcBackendClient, WorkspaceFile } from '../backend/backendClient'
import { MarkdownBody } from './MarkdownBody'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; body: string; revision: string }
  | { status: 'error'; message: string }

function isTextLike(file: WorkspaceFile) {
  return (
    file.kind === 'atom' ||
    /^text\//.test(file.contentType) ||
    file.contentType === 'application/json'
  )
}

// Markdown/text viewing + revision-checked editing through the backend
// client. Save failures keep the buffer on screen with the error —
// silent loss is never acceptable.
export function FileViewer({
  backendClient,
  file,
}: {
  backendClient: DohcBackendClient
  file: WorkspaceFile
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setSaveError(null)
    if (!isTextLike(file)) {
      setState({ status: 'ready', body: '', revision: '' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    backendClient.readText(file.path)
      .then(({ body, revision }) => {
        if (!cancelled) setState({ status: 'ready', body, revision })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not load this file.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [backendClient, file])

  if (!isTextLike(file)) {
    return (
      <div className="px-6 py-8 text-[13px] text-ink-dim">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          {file.contentType}
        </p>
        <p className="mt-2">
          No browser preview for this file type yet. It stays available in your
          synced workspace.
        </p>
      </div>
    )
  }
  if (state.status === 'loading') {
    return (
      <p className="px-6 py-8 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        loading…
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="px-6 py-8 text-[13px] text-danger">
        {state.message}
      </p>
    )
  }

  async function save() {
    if (state.status !== 'ready') return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await backendClient.writeText({
        path: file.path,
        body: draft,
        expectedRevision: state.revision,
      })
      setState({ status: 'ready', body: draft, revision: saved.revision ?? '' })
      setEditing(false)
    } catch (error) {
      // Conflict or outage: keep the draft visible, surface the cause.
      setSaveError(error instanceof Error ? error.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const isMarkdown = /markdown/.test(file.contentType) || /\.md$/i.test(file.path)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-rule px-4 py-2 sm:px-6">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
          {file.path}
        </span>
        {editing ? (
          <>
            <button
              type="button"
              data-testid="file-save"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-strong px-3 text-[12px] font-medium text-surface disabled:opacity-60"
            >
              {saving && <Loader2 className="size-3 animate-spin" />}
              Save
            </button>
            <button
              type="button"
              data-testid="file-cancel-edit"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim hover:bg-hover"
              aria-label="Cancel editing"
            >
              <X className="size-4" />
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="file-edit"
            onClick={() => {
              setDraft(state.body)
              setEditing(true)
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-ink-dim hover:bg-hover hover:text-ink"
          >
            <Pencil className="size-3.5" />
            Edit
          </button>
        )}
      </div>
      {saveError && (
        <p role="alert" className="border-b border-rule px-4 py-2 text-[12px] text-danger sm:px-6">
          {saveError}
        </p>
      )}
      {editing ? (
        <textarea
          data-testid="file-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-page px-4 py-4 font-mono text-[13px] leading-relaxed text-ink outline-none sm:px-6"
        />
      ) : (
        <div data-testid="file-body" className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {isMarkdown ? (
            <MarkdownBody body={state.body} />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-ink">
              {state.body}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
