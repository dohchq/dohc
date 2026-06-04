import { createRouter as createTanstackRouter } from '@tanstack/react-router'
import { NotFoundPage } from '@/components/NotFoundPage'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createTanstackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPendingMs: 0,
    defaultNotFoundComponent: NotFoundPage,
    notFoundMode: 'root',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
