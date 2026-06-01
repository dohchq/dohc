export type ViewPathInfo = {
  scopePath: string
  packageRoot: string
  viewName: string
  relativePath: string
}

function cleanOuterSlashes(path: string): string {
  return (path ?? '').trim().replace(/^\/+|\/+$/g, '')
}

function normalizePath(path: string): string {
  return cleanOuterSlashes(path).replace(/\/+/g, '/')
}

function hasUnsafeSegment(segments: string[]): boolean {
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
}

function isValidViewName(name: string | undefined): name is string {
  return Boolean(name && !name.startsWith('.') && name !== '.' && name !== '..')
}

export function parseViewPath(path: string): ViewPathInfo | null {
  const clean = cleanOuterSlashes(path)
  if (!clean || clean.includes('\u0000') || clean.includes('//')) return null

  const segments = clean.split('/')
  if (hasUnsafeSegment(segments)) return null

  const viewsIndex = segments.indexOf('.views')
  if (viewsIndex < 0) return null
  if (segments.indexOf('.views', viewsIndex + 1) >= 0) return null

  const viewName = segments[viewsIndex + 1]
  if (!isValidViewName(viewName)) return null

  const relativeSegments = segments.slice(viewsIndex + 2)
  if (relativeSegments.length === 0) return null

  const scopePath = segments.slice(0, viewsIndex).join('/')
  const packageRoot = [...segments.slice(0, viewsIndex), '.views', viewName].join('/')

  return {
    scopePath,
    packageRoot,
    viewName,
    relativePath: relativeSegments.join('/'),
  }
}

export function isViewPath(path: string): boolean {
  return parseViewPath(path) !== null
}

export function isViewPackageRoot(path: string): boolean {
  const clean = cleanOuterSlashes(path)
  if (!clean || clean.includes('\u0000') || clean.includes('//')) return false

  const segments = clean.split('/')
  if (hasUnsafeSegment(segments)) return false

  const viewsIndex = segments.indexOf('.views')
  if (viewsIndex < 0) return false
  if (segments.indexOf('.views', viewsIndex + 1) >= 0) return false

  return (
    viewsIndex === segments.length - 2 &&
    isValidViewName(segments[viewsIndex + 1])
  )
}

export function titleFromViewName(name: string): string {
  const words = (name ?? '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) return 'Untitled View'
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ')
}

export function resolveScopeRelativePath(
  scopePath: string,
  relativePath: string,
): string | null {
  const raw = (relativePath ?? '').trim()
  if (!raw || raw.startsWith('/')) return null

  const scope = normalizePath(scopePath)
  const scopeSegments = scope ? scope.split('/') : []
  if (hasUnsafeSegment(scopeSegments)) return null

  if (raw === '.') return scope

  const normalizedRelativePath = normalizePath(raw)
  const relativeSegments = normalizedRelativePath ? normalizedRelativePath.split('/') : []
  if (relativeSegments.length === 0 || hasUnsafeSegment(relativeSegments)) return null

  const resolved = [...scopeSegments, ...relativeSegments].join('/')
  return resolved
}
