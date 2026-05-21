const ASCII_SKETCH_LANGUAGE = 'ascii'
const ASCII_SKETCH_LANGUAGE_PREFIX = 'ascii:v1:'
const ASCII_SKETCH_CONTENT_PREFIX = 'vibe-ascii-sketch:v1:'

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(value, 'utf8').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  if (typeof atob !== 'function') return Buffer.from(padded, 'base64').toString('utf8')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function isAsciiSketchLanguage(language: unknown): boolean {
  return (
    language === ASCII_SKETCH_LANGUAGE ||
    (typeof language === 'string' && language.startsWith(ASCII_SKETCH_LANGUAGE_PREFIX))
  )
}

export function encodeAsciiSketchLanguage(snapshot: unknown): string {
  return `${ASCII_SKETCH_LANGUAGE_PREFIX}${toBase64Url(JSON.stringify(snapshot))}`
}

export function decodeAsciiSketchLanguage(language: unknown): unknown | null {
  if (typeof language !== 'string' || !language.startsWith(ASCII_SKETCH_LANGUAGE_PREFIX)) {
    return null
  }

  try {
    return JSON.parse(fromBase64Url(language.slice(ASCII_SKETCH_LANGUAGE_PREFIX.length)))
  } catch {
    return null
  }
}

export function encodeAsciiSketchContent(text: string, snapshot: unknown): string {
  return `${ASCII_SKETCH_CONTENT_PREFIX}${toBase64Url(JSON.stringify(snapshot))}\n${text}`
}

export function decodeAsciiSketchContent(
  text: string | undefined,
): { text: string; snapshot: unknown | null; hasMetadata: boolean } {
  if (!text) return { text: text ?? '', snapshot: null, hasMetadata: false }
  const newline = text.indexOf('\n')
  const firstLine = newline >= 0 ? text.slice(0, newline) : text
  if (!firstLine.startsWith(ASCII_SKETCH_CONTENT_PREFIX)) {
    return { text, snapshot: null, hasMetadata: false }
  }

  const rest = newline >= 0 ? text.slice(newline + 1) : ''
  try {
    return {
      text: rest,
      snapshot: JSON.parse(fromBase64Url(firstLine.slice(ASCII_SKETCH_CONTENT_PREFIX.length))),
      hasMetadata: true,
    }
  } catch {
    return { text: rest, snapshot: null, hasMetadata: true }
  }
}

export function hasAsciiSketchContentMetadata(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(ASCII_SKETCH_CONTENT_PREFIX)
}
