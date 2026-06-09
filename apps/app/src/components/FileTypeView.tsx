import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { FileText, Image as ImageIcon, Music, Table, FileCode2 } from 'lucide-react'

export type FileTypeViewProps = {
  path: string
  mediaType: string
  extension: string
  body?: string
  assetUrl?: string
}

export function FileTypeView({
  path,
  mediaType,
  extension,
  body,
  assetUrl,
}: FileTypeViewProps) {
  const [fetchedBody, setFetchedBody] = useState<string | null>(null)
  const ext = extension.toLowerCase()
  const textBody = body ?? fetchedBody ?? ''
  const isTextAsset =
    body === undefined &&
    Boolean(assetUrl) &&
    (mediaType.startsWith('text/') ||
      ['csv', 'txt', 'json'].includes(ext) ||
      mediaType === 'application/json')

  useEffect(() => {
    if (!isTextAsset || !assetUrl) return
    let cancelled = false
    void fetch(assetUrl)
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => {
        if (!cancelled) setFetchedBody(text)
      })
      .catch(() => {
        if (!cancelled) setFetchedBody('')
      })
    return () => {
      cancelled = true
    }
  }, [assetUrl, isTextAsset])

  if (ext === 'csv' || mediaType === 'text/csv') {
    return <CsvFileView path={path} body={textBody} />
  }
  if (ext === 'txt' || mediaType === 'text/plain') {
    return <PlainTextFileView path={path} body={textBody} />
  }
  if (ext === 'json' || mediaType === 'application/json') {
    return <JsonFileView path={path} body={textBody} />
  }
  if (ext === 'html' || mediaType === 'text/html') {
    return <HtmlFileView path={path} body={textBody} assetUrl={assetUrl} />
  }
  if (mediaType.startsWith('image/')) {
    return <ImageFileView path={path} assetUrl={assetUrl} />
  }
  if (mediaType.startsWith('audio/')) {
    return <AudioFileView path={path} assetUrl={assetUrl} />
  }
  if (ext === 'pdf' || mediaType === 'application/pdf') {
    return <PdfFileView path={path} assetUrl={assetUrl} />
  }
  if (ext === 'sqlite' || ext === 'db' || mediaType.includes('sqlite')) {
    return <SqliteFileView path={path} />
  }
  return <GenericFileView path={path} mediaType={mediaType} assetUrl={assetUrl} />
}

function SqliteFileView({ path }: { path: string }) {
  return (
    <FileViewShell path={path} label="SQLite database" Icon={Table}>
      <div
        data-testid="file-view-sqlite-placeholder"
        className="rounded-md border border-rule bg-panel px-3 py-2 text-sm text-ink-dim"
      >
        Database preview is not available for this file yet.
      </div>
    </FileViewShell>
  )
}

function FileViewShell({
  path,
  label,
  Icon,
  children,
}: {
  path: string
  label: string
  Icon: typeof FileText
  children: ReactNode
}) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-page text-ink">
      <header className="flex items-center gap-2 border-b border-rule px-4 py-3">
        <span className="grid size-7 place-items-center rounded-md bg-hover text-ink-dim">
          <Icon className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-ink-strong">
            {path}
          </h1>
          <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            {label}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </section>
  )
}

function CsvFileView({ path, body }: { path: string; body: string }) {
  const [raw, setRaw] = useState(false)
  const rows = useMemo(() => parseCsvPreview(body), [body])
  return (
    <FileViewShell path={path} label="CSV data" Icon={Table}>
      <div data-testid="file-view-csv" className="flex h-full min-h-0 flex-col">
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={() => setRaw((value) => !value)}
            className="rounded-md border border-rule px-2 py-1 text-[11px] text-ink-dim hover:bg-hover hover:text-ink"
          >
            {raw ? 'table' : 'raw text'}
          </button>
        </div>
        {raw ? (
          <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-rule bg-surface p-3 font-mono text-[12px] leading-relaxed">
            {body}
          </pre>
        ) : (
          <table className="w-full border-collapse text-left text-[12px]">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-rule">
                  {row.map((cell, cellIndex) =>
                    rowIndex === 0 ? (
                      <th
                        key={cellIndex}
                        className="bg-panel px-2 py-1.5 font-semibold text-ink-strong"
                      >
                        {cell}
                      </th>
                    ) : (
                      <td key={cellIndex} className="px-2 py-1.5 text-ink-dim">
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </FileViewShell>
  )
}

function PlainTextFileView({ path, body }: { path: string; body: string }) {
  return (
    <FileViewShell path={path} label="Plain text" Icon={FileText}>
      <textarea
        aria-label="Plain text file contents"
        value={body}
        readOnly
        className="min-h-[60vh] w-full resize-none rounded-md border border-rule bg-surface p-3 font-mono text-[13px] leading-relaxed text-ink outline-none"
      />
    </FileViewShell>
  )
}

function JsonFileView({ path, body }: { path: string; body: string }) {
  return (
    <FileViewShell path={path} label="JSON" Icon={FileCode2}>
      <pre
        data-language="json"
        className="min-h-[60vh] overflow-auto rounded-md border border-rule bg-surface p-3 font-mono text-[12px] leading-relaxed"
      >
        {formatJson(body)}
      </pre>
    </FileViewShell>
  )
}

function HtmlFileView({
  path,
  body,
  assetUrl,
}: {
  path: string
  body: string
  assetUrl?: string
}) {
  return (
    <FileViewShell path={path} label="HTML" Icon={FileCode2}>
      <iframe
        title={`HTML preview: ${path}`}
        sandbox=""
        src={assetUrl}
        srcDoc={assetUrl ? undefined : body}
        className="h-full min-h-[60vh] w-full border-0 bg-surface"
      />
    </FileViewShell>
  )
}

function ImageFileView({
  path,
  assetUrl,
}: {
  path: string
  assetUrl?: string
}) {
  return (
    <FileViewShell path={path} label="Image" Icon={ImageIcon}>
      {assetUrl ? (
        <img
          src={assetUrl}
          alt={path}
          className="max-h-full max-w-full object-contain"
        />
      ) : (
        <p className="text-sm text-ink-dim">Image preview unavailable.</p>
      )}
    </FileViewShell>
  )
}

function AudioFileView({
  path,
  assetUrl,
}: {
  path: string
  assetUrl?: string
}) {
  return (
    <FileViewShell path={path} label="Audio" Icon={Music}>
      <div data-testid="file-view-audio">
        {assetUrl ? (
          <audio src={assetUrl} controls preload="metadata" className="w-full" />
        ) : (
          <p className="text-sm text-ink-dim">Audio preview unavailable.</p>
        )}
      </div>
    </FileViewShell>
  )
}

function PdfFileView({
  path,
  assetUrl,
}: {
  path: string
  assetUrl?: string
}) {
  return (
    <FileViewShell path={path} label="PDF" Icon={FileText}>
      <div data-testid="file-view-pdf" className="h-full min-h-[65vh]">
        {assetUrl ? (
          <object
            data={assetUrl}
            type="application/pdf"
            className="h-full min-h-[65vh] w-full"
          >
            <a href={assetUrl} className="text-sm underline underline-offset-2">
              Download {path}
            </a>
          </object>
        ) : (
          <p className="text-sm text-ink-dim">PDF preview unavailable.</p>
        )}
      </div>
    </FileViewShell>
  )
}

function GenericFileView({
  path,
  mediaType,
  assetUrl,
}: {
  path: string
  mediaType: string
  assetUrl?: string
}) {
  return (
    <FileViewShell path={path} label={mediaType || 'File'} Icon={FileText}>
      {assetUrl ? (
        <a
          href={assetUrl}
          className="inline-flex rounded-md border border-rule px-3 py-2 text-sm text-ink-dim hover:bg-hover hover:text-ink"
        >
          Open file
        </a>
      ) : (
        <p className="text-sm text-ink-dim">Preview unavailable.</p>
      )}
    </FileViewShell>
  )
}

function parseCsvPreview(body: string): string[][] {
  return body
    .trim()
    .split(/\r?\n/)
    .slice(0, 50)
    .map((line) => line.split(',').map((cell) => cell.trim()))
}

function formatJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}
