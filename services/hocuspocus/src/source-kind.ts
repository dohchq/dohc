const SOURCE_PLAIN_TEXT_EXT_RE = /\.(?:tsx?|jsx?|css|json)$/i

// Website/source files collab as plain-text Y.Text docs, never as rich
// markdown documents.
export function isPlainTextAtomPath(path: string): boolean {
  const clean = path.replace(/\\/g, '/')
  return SOURCE_PLAIN_TEXT_EXT_RE.test(clean)
}
