import { useCallback, useRef, useState } from 'react'
import { AlertCircle, Loader2, Upload } from 'lucide-react'
import type { DohcBackendClient, WorkspaceFile } from '../backend/backendClient'

const WORKSPACE_UPLOAD_ACCEPT = [
  'image/png',
  'image/jpeg',
  'application/pdf',
  'audio/mp4',
  'audio/x-m4a',
  '.m4a',
  '.csv',
  '.txt',
  '.json',
  '.sqlite',
  '.db',
  'application/octet-stream',
].join(',')

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'error'; message: string }

export function UploadFileButton({
  backendClient,
  defaultFolderPath = '',
  onUploaded,
}: {
  backendClient: Pick<DohcBackendClient, 'uploadFile'>
  defaultFolderPath?: string
  onUploaded: (file: WorkspaceFile) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [state, setState] = useState<UploadState>({ status: 'idle' })

  const openFilePicker = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    if (typeof input.showPicker === 'function') input.showPicker()
    else input.click()
  }, [])

  async function uploadFile(file: File) {
    const path = workspaceUploadPath(defaultFolderPath, file.name || 'uploaded file')
    setState({ status: 'uploading' })
    try {
      const created = await backendClient.uploadFile({ file, path })
      setState({ status: 'idle' })
      onUploaded(created)
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Upload failed',
      })
    }
  }

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={openFilePicker}
        disabled={state.status === 'uploading'}
        className="inline-flex size-7 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
        title="Upload file"
        aria-label="Upload file"
      >
        {state.status === 'uploading' ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={2} />
        ) : state.status === 'error' ? (
          <AlertCircle className="size-4 text-danger" strokeWidth={2} />
        ) : (
          <Upload className="size-4" strokeWidth={2} />
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={WORKSPACE_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const [file] = Array.from(event.currentTarget.files ?? [])
          if (file) void uploadFile(file)
          event.currentTarget.value = ''
        }}
      />
      {state.status === 'error' && (
        <span
          role="status"
          className="absolute right-0 top-8 z-20 w-48 rounded-md border border-danger/30 bg-elevated px-2 py-1 text-[11px] leading-snug text-danger shadow-sm"
        >
          {state.message}
        </span>
      )}
    </span>
  )
}

function workspaceUploadPath(folderPath: string, filename: string) {
  const cleanFolder = folderPath.trim().replace(/^\/+|\/+$/g, '')
  const cleanName = filename.trim().replace(/^\/+|\/+$/g, '') || 'uploaded file'
  return cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName
}
