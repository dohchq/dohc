export type AppView = 'agent' | 'atom' | 'views' | 'graph'

export function viewFromPathname(pathname: string): AppView | null {
  if (/^(?:\/w\/[^/]+)?\/v\/[^/]+\/?$/.test(pathname)) return 'views'
  const match = /^(?:\/w\/[^/]+)?\/(agent|files|views|graph)\/?$/.exec(pathname)
  if (!match) return null
  if (match[1] === 'files') return 'atom'
  return match[1] as 'agent' | 'views' | 'graph'
}
