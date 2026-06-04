import { createRouter as createTanstackRouter } from '@tanstack/react-router'
import { NotFoundPage } from './components/NotFoundPage'
import { routeTree } from './routeTree.gen'

type RouterOptions = Parameters<typeof createTanstackRouter>[0]

export function getRouter(options: Partial<RouterOptions> = {}) {
  return createTanstackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPendingMs: 0,
    defaultNotFoundComponent: NotFoundPage,
    notFoundMode: 'root',
    ...options,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
