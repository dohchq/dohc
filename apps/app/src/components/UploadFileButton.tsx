import { useCallback, useRef, useState } from 'react'
import { useMutation } from 'convex/react'
import { AlertCircle, Loader2, Upload } from 'lucide-react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type { DohcBackendClient } from '../backend/backendClient'
import { mediaTypeForWorkspacePath } from '../lib/mediaTypes'
import { uploadBlobToStorageUrl } from '../lib/storageUpload'

export const WORKSPACE_UPLOAD_ACCEPT = [
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

export type UploadedWorkspaceFile = {
  _id: string
  path: string
  title?: string | null
  source: string
  kind: 'asset'
  contentType: string
}

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: number }
  | { status: 'error'; message: string }

export function UploadFileButton({
  activeWorkspaceId,
  backendClient,
  defaultFolderPath = '',
  onUploaded,
}: {
  activeWorkspaceId?: string
  backendClient?: Pick<DohcBackendClient, 'uploadFile'>
  defaultFolderPath?: string
  onUploaded: (file: UploadedWorkspaceFile) => void
}) {
  const generateUploadUrl = useMutation(api.assets.generateUploadUrl)
  const registerWorkspaceFile = useMutation(api.assets.registerWorkspaceFile)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [state, setState] = useState<UploadState>({ status: 'idle' })

  const openFilePicker = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    if (typeof input.showPicker === 'function') input.showPicker()
    else input.click()
  }, [])

  async function uploadFile(file: File) {
    const filename = file.name || 'uploaded file'
    const mediaType =
      file.type || mediaTypeForWorkspacePath(filename) || 'application/octet-stream'
    const path = workspaceUploadPath(defaultFolderPath, filename)
    setState({ status: 'uploading', progress: 1 })
    try {
      if (backendClient) {
        const created = await backendClient.uploadFile({ file, path })
        setState({ status: 'idle' })
        onUploaded(created as UploadedWorkspaceFile)
        return
      }
      const uploadUrl = await generateUploadUrl({ activeWorkspaceId })
      const storageId = await uploadBlobToStorageUrl(uploadUrl, file, {
        mediaType,
        onProgress: ({ percent }) =>
          setState({ status: 'uploading', progress: percent }),
      })
      const created = await registerWorkspaceFile({
        activeWorkspaceId,
        storageId: storageId as Id<'_storage'>,
        filename,
        mediaType,
        path,
      })
      setState({ status: 'idle' })
      onUploaded(created as UploadedWorkspaceFile)
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
      {state.status === 'uploading' && (
        <span className="sr-only">Uploading {state.progress}%</span>
      )}
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
