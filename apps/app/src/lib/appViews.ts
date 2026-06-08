export type AppView = 'agent' | 'atom' | 'views' | 'graph'

export function viewFromPathname(pathname: string): AppView | null {
  if (/^\/[^/]+\/a\/[^/]+\/?$/.test(pathname)) return 'views'
  if (/^\/[^/]+\/v\/[^/]+\/?$/.test(pathname)) return 'views'
  if (/^\/[^/]+\/agent(?:\/[^/]+)?\/?$/.test(pathname)) return 'agent'
  const match = /^\/[^/]+\/(files|apps|views|graph)\/?$/.exec(pathname)
  if (!match) return null
  if (match[1] === 'files') return 'atom'
  if (match[1] === 'apps') return 'views'
  return match[1] as 'views' | 'graph'
}
