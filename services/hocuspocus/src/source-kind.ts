const VIEW_PLAIN_TEXT_EXT_RE = /\.(?:tsx?|jsx?|css|json)$/i

export function isPlainTextAtomPath(path: string): boolean {
  const clean = path.replace(/\\/g, '/')
  return (
    (clean.startsWith('.views/') || clean.includes('/.views/')) &&
    VIEW_PLAIN_TEXT_EXT_RE.test(clean)
  )
}
