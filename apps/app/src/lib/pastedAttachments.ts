export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

export type AssetMarkdownReferenceInput = {
  kind: AttachmentKind
  assetId: string
  label: string
}

export type DohcAssetHref = {
  kind: AttachmentKind
  assetId: string
}

const TEXT_EXTENSIONS = new Set([
  'csv',
  'css',
  'html',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'mdx',
  'sql',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
])

const TEXT_MEDIA_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/ld+json',
  'application/markdown',
  'application/x-ndjson',
  'application/xml',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/x-markdown',
])

export function attachmentKindForType(mediaType?: string | null): AttachmentKind {
  const normalized = (mediaType ?? '').toLowerCase()
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  return 'file'
}

export function isInlineTextType(
  mediaType?: string | null,
  filename?: string | null,
): boolean {
  const normalized = (mediaType ?? '').toLowerCase()
  if (normalized.startsWith('text/')) return true
  if (TEXT_MEDIA_TYPES.has(normalized)) return true
  const extension = (filename ?? '').split('.').pop()?.toLowerCase()
  return extension ? TEXT_EXTENSIONS.has(extension) : false
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${trimUnit(kb)} KB`
  return `${trimUnit(kb / 1024)} MB`
}

export function assetMarkdownReference({
  kind,
  assetId,
  label,
}: AssetMarkdownReferenceInput): string {
  const href = `dohc-asset:${kind}/${assetId}`
  const safeLabel = label.replaceAll(']', '\\]')
  return kind === 'image' ? `![${safeLabel}](${href})` : `[${safeLabel}](${href})`
}

export function parseDohcAssetHref(href?: string | null): DohcAssetHref | null {
  const match = /^dohc-asset:(image|video|audio|file)\/(.+)$/.exec(href ?? '')
  if (!match) return null
  return {
    kind: match[1] as AttachmentKind,
    assetId: match[2],
  }
}

function trimUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
