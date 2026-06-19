const APP_PLAIN_TEXT_EXT_RE = /\.(?:tsx?|jsx?|css|json)$/i

// App source files (`.apps/<name>/…`, see workspace-core classifyPath) collab
// as plain-text Y.Text docs, never as rich markdown documents.
export function isPlainTextAtomPath(path: string): boolean {
  const clean = path.replace(/\\/g, '/')
  return (
    (clean.startsWith('.apps/') || clean.includes('/.apps/')) &&
    APP_PLAIN_TEXT_EXT_RE.test(clean)
  )
}
