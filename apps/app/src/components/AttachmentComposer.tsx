import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react'
import { useMutation } from 'convex/react'
import {
  AlertCircle,
  FileText,
  Image as ImageIcon,
  Loader2,
  Music,
  Paperclip,
  Video,
  X,
} from 'lucide-react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  attachmentKindForType,
  formatAttachmentSize,
  type AttachmentKind,
} from '../lib/pastedAttachments'
import { uploadBlobToStorageUrl } from '../lib/storageUpload'

export type ComposerAttachment = {
  id: string
  assetId?: Id<'workspaceAssets'>
  filename: string
  mediaType: string
  kind: AttachmentKind
  size: number
  status: 'uploading' | 'ready' | 'error'
  phase?: 'preparing' | 'uploading' | 'registering'
  progress?: number
  error?: string
}

type UseAttachmentUploadsArgs = {
  activeWorkspaceId?: string
  purpose?: 'chat' | 'workspace'
}

export function useAttachmentUploads({
  activeWorkspaceId,
  purpose = 'chat',
}: UseAttachmentUploadsArgs) {
  const generateUploadUrl = useMutation(api.assets.generateUploadUrl)
  const registerUploadedAsset = useMutation(api.assets.registerUploadedAsset)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [isDragActive, setIsDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  const uploadFile = useCallback(
    async (file: File) => {
      const mediaType = file.type || 'application/octet-stream'
      const kind = attachmentKindForType(mediaType)
      const filename = file.name || fallbackFilename(kind)
      const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setAttachments((items) => [
        ...items,
        {
          id,
          filename,
          mediaType,
          kind,
          size: file.size,
          status: 'uploading',
          phase: 'preparing',
        },
      ])

      try {
        const uploadUrl = await generateUploadUrl({ activeWorkspaceId })
        setAttachments((items) =>
          items.map((item) =>
            item.id === id
              ? { ...item, phase: 'uploading', progress: 1 }
              : item,
          ),
        )
        const storageId = await uploadBlobToStorageUrl(uploadUrl, file, {
          mediaType,
          onProgress: ({ percent }) => {
            setAttachments((items) =>
              items.map((item) =>
                item.id === id
                  ? { ...item, phase: 'uploading', progress: percent }
                  : item,
              ),
            )
          },
        })
        setAttachments((items) =>
          items.map((item) =>
            item.id === id
              ? { ...item, phase: 'registering', progress: 100 }
              : item,
          ),
        )
        const asset = await registerUploadedAsset({
          activeWorkspaceId,
          storageId,
          filename,
          mediaType,
          purpose,
        })
        setAttachments((items) =>
          items.map((item) =>
            item.id === id
              ? {
                  ...item,
                  assetId: asset.assetId as Id<'workspaceAssets'>,
                  kind: asset.kind as AttachmentKind,
                  mediaType: asset.mediaType,
                  size: asset.size,
                  status: 'ready',
                  phase: undefined,
                  progress: 100,
                }
              : item,
          ),
        )
      } catch (error) {
        setAttachments((items) =>
          items.map((item) =>
            item.id === id
              ? { ...item, status: 'error', error: attachmentError(error) }
              : item,
          ),
        )
      }
    },
    [activeWorkspaceId, generateUploadUrl, purpose, registerUploadedAsset],
  )

  const addFiles = useCallback(
    (files: Iterable<File> | ArrayLike<File>) => {
      const list = Array.from(files).filter((file) => file.size > 0)
      for (const file of list) void uploadFile(file)
    },
    [uploadFile],
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const files = clipboardFiles(event.clipboardData)
      if (files.length === 0) return
      if (!event.clipboardData.getData('text/plain')) event.preventDefault()
      addFiles(files)
    },
    [addFiles],
  )

  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setIsDragActive(true)
  }, [])

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragActive(false)
  }, [])

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const files = dataTransferFiles(event.dataTransfer)
      dragDepthRef.current = 0
      setIsDragActive(false)
      if (files.length === 0) return
      event.preventDefault()
      addFiles(files)
    },
    [addFiles],
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((items) => items.filter((item) => item.id !== id))
  }, [])

  const clearReadyAttachmentIds = useCallback((assetIds: Id<'workspaceAssets'>[]) => {
    const ids = new Set(assetIds)
    setAttachments((items) =>
      items.filter((item) => !item.assetId || !ids.has(item.assetId)),
    )
  }, [])

  const resetAttachments = useCallback(() => setAttachments([]), [])

  const readyAssetIds = useMemo(
    () =>
      attachments
        .filter((item): item is ComposerAttachment & { assetId: Id<'workspaceAssets'> } =>
          item.status === 'ready' && Boolean(item.assetId),
        )
        .map((item) => item.assetId),
    [attachments],
  )
  const hasUploading = attachments.some((item) => item.status === 'uploading')
  const hasErrors = attachments.some((item) => item.status === 'error')

  return {
    attachments,
    readyAssetIds,
    hasUploading,
    hasErrors,
    isDragActive,
    addFiles,
    handlePaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeAttachment,
    clearReadyAttachmentIds,
    resetAttachments,
  }
}

export function AttachmentUploadButton({
  uploader,
  disabled = false,
  compact = false,
}: {
  uploader: Pick<ReturnType<typeof useAttachmentUploads>, 'addFiles'>
  disabled?: boolean
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const openFilePicker = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    if (typeof input.showPicker === 'function') input.showPicker()
    else input.click()
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={openFilePicker}
        disabled={disabled}
        className={`grid shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? 'size-7' : 'size-8'
        }`}
        title="Attach files"
        aria-label="Attach files"
      >
        <Paperclip className={compact ? 'size-3.5' : 'size-4'} strokeWidth={2} />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.currentTarget.files) {
            uploader.addFiles(event.currentTarget.files)
          }
          event.currentTarget.value = ''
        }}
      />
    </>
  )
}

export function AttachmentTray({
  attachments,
  onRemove,
  compact = false,
}: {
  attachments: ComposerAttachment[]
  onRemove: (id: string) => void
  compact?: boolean
}) {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((attachment) => {
        const Icon = iconForKind(attachment.kind)
        const failed = attachment.status === 'error'
        const statusLabel = attachmentStatusLabel(attachment)
        return (
          <span
            key={attachment.id}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 text-ink-dim ${
              compact ? 'h-7 text-[11px]' : 'h-8 text-[11.5px]'
            } ${
              failed
                ? 'border-danger/30 bg-danger/5'
                : 'border-rule bg-surface/80'
            }`}
            title={
              failed
                ? attachment.error
                : `${attachment.filename} (${statusLabel})`
            }
          >
            {attachment.status === 'uploading' ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-ink-faint" />
            ) : failed ? (
              <AlertCircle className="size-3.5 shrink-0 text-danger" />
            ) : (
              <Icon className="size-3.5 shrink-0 text-ink-faint" strokeWidth={2} />
            )}
            <span className="max-w-[180px] truncate font-medium text-ink">
              {attachment.filename}
            </span>
            <span className="shrink-0 text-ink-faint">{statusLabel}</span>
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              className="ml-0.5 grid size-4 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-hover hover:text-ink"
              title="Remove attachment"
              aria-label={`Remove ${attachment.filename}`}
            >
              <X className="size-3" strokeWidth={2.4} />
            </button>
          </span>
        )
      })}
    </div>
  )
}

export function AttachmentDropOverlay({ compact = false }: { compact?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-1.5 z-30 grid place-items-center rounded-[14px] border border-dashed border-accent/70 bg-elevated/92 shadow-inner backdrop-blur-sm">
      <div className="flex items-center gap-2 rounded-full border border-rule bg-surface px-3 py-2 shadow-xs">
        <span className="grid size-7 place-items-center rounded-full bg-accent/10 text-accent">
          <Paperclip className="size-3.5" strokeWidth={2.2} />
        </span>
        <span className="text-left">
          <span
            className={`block font-semibold text-ink-strong ${
              compact ? 'text-[11.5px]' : 'text-[12.5px]'
            }`}
          >
            Drop files here
          </span>
          {!compact && (
            <span className="block text-[10.5px] text-ink-faint">
              They’ll attach to this message.
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

export function MessageFileParts({ parts }: { parts: Array<{ type?: string }> }) {
  const fileParts = parts
    .map((part) => normalizeMessageFilePart(part))
    .filter((part): part is MessageFilePart => part !== null)
  if (fileParts.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {fileParts.map((part, index) =>
        part.kind === 'image' && part.url ? (
          <a
            key={`${part.url}-${index}`}
            href={part.url}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-lg border border-rule bg-surface"
          >
            <img
              src={part.url}
              alt={part.filename}
              className="max-h-44 max-w-64 object-contain"
            />
          </a>
        ) : (
          <a
            key={`${part.url ?? part.filename}-${index}`}
            href={part.url}
            target={part.url ? '_blank' : undefined}
            rel={part.url ? 'noreferrer' : undefined}
            className="inline-flex h-8 max-w-full items-center gap-2 rounded-md border border-rule bg-surface px-2.5 text-[11.5px] font-medium text-ink-dim"
          >
            {part.kind === 'video' ? (
              <Video className="size-3.5 shrink-0 text-ink-faint" strokeWidth={2} />
            ) : part.kind === 'audio' ? (
              <Music className="size-3.5 shrink-0 text-ink-faint" strokeWidth={2} />
            ) : (
              <FileText className="size-3.5 shrink-0 text-ink-faint" strokeWidth={2} />
            )}
            <span className="max-w-[220px] truncate">{part.filename}</span>
          </a>
        ),
      )}
    </div>
  )
}

type MessageFilePart = {
  filename: string
  mediaType: string
  kind: AttachmentKind
  url?: string
}

function normalizeMessageFilePart(part: { type?: string }): MessageFilePart | null {
  if (part.type !== 'file' && part.type !== 'image') return null
  const value = part as {
    data?: unknown
    image?: unknown
    filename?: unknown
    mediaType?: unknown
    mimeType?: unknown
  }
  const mediaType =
    typeof value.mediaType === 'string'
      ? value.mediaType
      : typeof value.mimeType === 'string'
        ? value.mimeType
        : part.type === 'image'
          ? 'image/*'
          : 'application/octet-stream'
  const data = value.data ?? value.image
  const url = typeof data === 'string' && /^https?:|^data:/.test(data) ? data : undefined
  const kind = part.type === 'image' ? 'image' : attachmentKindForType(mediaType)
  return {
    filename:
      typeof value.filename === 'string' && value.filename.trim()
        ? value.filename
        : fallbackFilename(kind),
    mediaType,
    kind,
    url,
  }
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = dataTransferFiles(data)
  if (files.length > 0) return files
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
}

function dataTransferFiles(data: DataTransfer): File[] {
  return Array.from(data.files ?? []).filter((file) => file.size > 0)
}

function hasDraggedFiles(data: DataTransfer | null): boolean {
  return Boolean(data?.types.includes('Files'))
}

function attachmentStatusLabel(attachment: ComposerAttachment): string {
  if (attachment.status === 'error') return 'failed'
  if (attachment.status === 'ready') return formatAttachmentSize(attachment.size)
  if (attachment.phase === 'registering') return 'saving'
  if (attachment.phase === 'uploading') {
    return attachment.progress ? `${attachment.progress}%` : 'uploading'
  }
  return 'starting'
}

function iconForKind(kind: AttachmentKind) {
  if (kind === 'image') return ImageIcon
  if (kind === 'video') return Video
  if (kind === 'audio') return Music
  return FileText
}

function fallbackFilename(kind: AttachmentKind): string {
  if (kind === 'image') return 'pasted image'
  if (kind === 'video') return 'pasted video'
  if (kind === 'audio') return 'pasted audio'
  return 'attachment'
}

function attachmentError(error: unknown): string {
  return error instanceof Error ? error.message : 'Upload failed'
}
