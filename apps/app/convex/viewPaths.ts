export type ViewPathInfo = {
  scopePath: string
  packageRoot: string
  viewName: string
  relativePath: string
}

export type AppPathInfo = {
  scopePath: string
  packageRoot: string
  appName: string
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

function parsePackagePath(
  path: string,
  marker: '.apps' | '.views',
): {
  scopePath: string
  packageRoot: string
  packageName: string
  relativePath: string
} | null {
  const clean = cleanOuterSlashes(path)
  if (!clean || clean.includes('\u0000') || clean.includes('//')) return null

  const segments = clean.split('/')
  if (hasUnsafeSegment(segments)) return null

  const markerIndex = segments.indexOf(marker)
  if (markerIndex < 0) return null
  if (segments.indexOf(marker, markerIndex + 1) >= 0) return null

  const packageName = segments[markerIndex + 1]
  if (!isValidViewName(packageName)) return null

  const relativeSegments = segments.slice(markerIndex + 2)
  if (relativeSegments.length === 0) return null

  const scopePath = segments.slice(0, markerIndex).join('/')
  const packageRoot = [...segments.slice(0, markerIndex), marker, packageName].join('/')

  return {
    scopePath,
    packageRoot,
    packageName,
    relativePath: relativeSegments.join('/'),
  }
}

export function parseViewPath(path: string): ViewPathInfo | null {
  const parsed = parsePackagePath(path, '.views')
  if (!parsed) return null
  return {
    scopePath: parsed.scopePath,
    packageRoot: parsed.packageRoot,
    viewName: parsed.packageName,
    relativePath: parsed.relativePath,
  }
}

export function parseAppPath(path: string): AppPathInfo | null {
  const parsed = parsePackagePath(path, '.apps')
  if (!parsed) return null
  return {
    scopePath: parsed.scopePath,
    packageRoot: parsed.packageRoot,
    appName: parsed.packageName,
    relativePath: parsed.relativePath,
  }
}

export function isViewPath(path: string): boolean {
  return parseViewPath(path) !== null
}

function isPackageRoot(path: string, marker: '.apps' | '.views'): boolean {
  const clean = cleanOuterSlashes(path)
  if (!clean || clean.includes('\u0000') || clean.includes('//')) return false

  const segments = clean.split('/')
  if (hasUnsafeSegment(segments)) return false

  const markerIndex = segments.indexOf(marker)
  if (markerIndex < 0) return false
  if (segments.indexOf(marker, markerIndex + 1) >= 0) return false

  return (
    markerIndex === segments.length - 2 &&
    isValidViewName(segments[markerIndex + 1])
  )
}

export function isViewPackageRoot(path: string): boolean {
  return isPackageRoot(path, '.views')
}

export function isAppPath(path: string): boolean {
  return parseAppPath(path) !== null
}

export function isAppPackageRoot(path: string): boolean {
  return isPackageRoot(path, '.apps')
}

function titleFromPackageName(name: string, fallback: string): string {
  const words = (name ?? '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) return fallback
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ')
}

export function titleFromViewName(name: string): string {
  return titleFromPackageName(name, 'Untitled View')
}

export function titleFromAppName(name: string): string {
  return titleFromPackageName(name, 'Untitled App')
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
