const SITE_SOURCE_PLAIN_TEXT_EXT_RE = /\.(?:tsx?|jsx?|css|json)$/i

// Site source files collab as plain-text Y.Text docs, never as rich
// markdown documents.
export function isPlainTextAtomPath(path: string): boolean {
  const clean = path.replace(/\\/g, '/')
  return (
    (clean.startsWith('sites/') || clean.includes('/sites/')) &&
    SITE_SOURCE_PLAIN_TEXT_EXT_RE.test(clean)
  )
}
