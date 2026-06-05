export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

export type AssetMarkdownReferenceInput = {
  kind: AttachmentKind
  assetId: string
  label: string
}

export type AssetHref = {
  kind: AttachmentKind
  assetId: string
}

const TEXT_EXTENSIONS = new Set([
  'astro',
  'bash',
  'bat',
  'c',
  'cc',
  'cfg',
  'cmd',
  'conf',
  'cpp',
  'cs',
  'csv',
  'css',
  'dockerfile',
  'env',
  'fish',
  'go',
  'gql',
  'gradle',
  'graphql',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'kts',
  'less',
  'log',
  'lock',
  'md',
  'mdx',
  'php',
  'properties',
  'ps1',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svelte',
  'svg',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
])

const TEXT_MEDIA_TYPES = new Set([
  'application/csv',
  'application/graphql',
  'application/json',
  'application/javascript',
  'application/ld+json',
  'application/markdown',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-sh',
  'application/x-ndjson',
  'application/x-yaml',
  'application/xml',
  'image/svg+xml',
  'text/csv',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/typescript',
  'text/x-markdown',
  'text/xml',
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
  const basename = (filename ?? '').split('/').pop()?.toLowerCase() ?? ''
  if (basename.startsWith('dockerfile') || basename.startsWith('.env')) {
    return true
  }
  const extension = basename.split('.').pop()?.toLowerCase()
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

export function parseAssetHref(href?: string | null): AssetHref | null {
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
