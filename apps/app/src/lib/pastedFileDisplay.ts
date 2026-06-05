const PASTED_FILE_BLOCK_RE =
  /<pasted-file\b([^>]*)>[\s\S]*?<\/pasted-file>/gi
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g

export function collapsePastedFileBlocks(text: string): string {
  if (!text.includes('<pasted-file')) return text

  return text
    .replace(PASTED_FILE_BLOCK_RE, (_block, rawAttrs: string) => {
      const attrs = parseAttributes(rawAttrs)
      const name = attrs.name?.trim() || 'attachment'
      const mediaType = attrs.mediaType?.trim() || attrs.type?.trim() || 'file'
      return `Attached file: ${name} · ${mediaType}`
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  for (const match of raw.matchAll(ATTR_RE)) {
    attrs[match[1]] = decodeAttribute(match[2])
  }
  return attrs
}

function decodeAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
