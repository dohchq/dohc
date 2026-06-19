import { createRouter as createTanstackRouter } from '@tanstack/react-router'
import { NotFoundPage } from './components/NotFoundPage'
import { routeTree } from './routeTree.gen'

type RouterOptions = Parameters<typeof createTanstackRouter>[0]
type AppRouter = ReturnType<typeof createTanstackRouter>

export function getRouter(options: Partial<RouterOptions> = {}): AppRouter {
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
    router: AppRouter
  }
}
