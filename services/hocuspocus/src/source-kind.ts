import { SITE_SOURCE_CODE_EXT_RE } from '@dohc/workspace-contracts/domain'

// Site source files collab as plain-text Y.Text docs, never as rich
// markdown documents.
export function isPlainTextAtomPath(path: string): boolean {
  const clean = path.replace(/\\/g, '/')
  const segments = clean.split('/').filter(Boolean)
  return (
    segments.includes('sites') &&
    SITE_SOURCE_CODE_EXT_RE.test(clean)
  )
}
