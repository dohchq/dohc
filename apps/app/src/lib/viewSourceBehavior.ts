import { isHtmlAtomBody } from './atomId'
import { parseViewPath } from './viewPaths'

export function isSourceFirstPath(path: string | null | undefined): boolean {
  if (!path) return false
  return /\.(tsx?|jsx?|css|json)$/i.test(path) || parseViewPath(path) !== null
}

export function viewPackageRootForSourcePath(path: string | null | undefined): string | null {
  return path ? (parseViewPath(path)?.packageRoot ?? null) : null
}

export function shouldRenderHtmlAtomFrame({
  path,
  pathIsHtml,
  draft,
}: {
  path: string | null | undefined
  pathIsHtml: boolean
  draft: string
}): boolean {
  if (viewPackageRootForSourcePath(path)) return false
  return pathIsHtml || isHtmlAtomBody(draft)
}
