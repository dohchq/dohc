const GLOB_RE = /[?*\[]/

export function hasGlob(value: string): boolean {
  return GLOB_RE.test(value)
}

export function globBase(scope: string): string {
  const index = scope.search(GLOB_RE)
  const base = index >= 0 ? scope.slice(0, index) : scope
  return base.replace(/\/+$/g, '')
}

export function globMatchesPath(glob: string, path: string): boolean {
  if (!hasGlob(glob)) return path === glob
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`).test(path)
}

function nonGlobScopeContains(scope: string, candidate: string): boolean {
  if (scope === '') return true
  return candidate === scope || candidate.startsWith(`${scope}/`)
}

function globScopeContainsGlob(scope: string, candidate: string): boolean {
  if (scope === candidate) return true
  if (scope.endsWith('/**')) {
    const base = scope.slice(0, -3)
    const candidateBase = globBase(candidate)
    return nonGlobScopeContains(base, candidateBase)
  }
  return false
}

export function pathInScope(candidate: string, scope: string): boolean {
  if (scope === '') return true
  if (!hasGlob(scope) && !hasGlob(candidate)) {
    return nonGlobScopeContains(scope, candidate)
  }
  if (hasGlob(scope) && !hasGlob(candidate)) {
    return globMatchesPath(scope, candidate)
  }
  if (!hasGlob(scope) && hasGlob(candidate)) {
    return nonGlobScopeContains(scope, globBase(candidate))
  }
  return globScopeContainsGlob(scope, candidate)
}

export function scopeAllowsPath(scopes: string[], path: string): boolean {
  return scopes.some((scope) => pathInScope(path, scope))
}
