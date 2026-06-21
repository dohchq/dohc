import { isSiteSourcePath } from '@dohc/workspace-core/paths'

// Site source files collab as plain-text Y.Text docs, never as rich
// markdown documents.
export function isPlainTextAtomPath(path: string): boolean {
  return isSiteSourcePath(path)
}
