import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_ROUTE_SRC = readFileSync(
  resolve(__dirname, '../../src/routes/__root.tsx'),
  'utf8',
)
const APP_ROUTE_SRC = readFileSync(
  resolve(__dirname, '../../src/routes/_app.tsx'),
  'utf8',
)
const ROUTER_SRC = readFileSync(resolve(__dirname, '../../src/router.tsx'), 'utf8')
const NOT_FOUND_SRC = readFileSync(
  resolve(__dirname, '../../src/components/NotFoundPage.tsx'),
  'utf8',
)

describe('root 404 page', () => {
  it('wires a branded not-found component into the root route', () => {
    expect(ROOT_ROUTE_SRC).toContain('notFoundComponent: NotFoundPage')
    expect(ROOT_ROUTE_SRC).toContain('@/components/NotFoundPage')
    expect(ROUTER_SRC).toContain('defaultNotFoundComponent: NotFoundPage')
    expect(ROUTER_SRC).toContain("notFoundMode: 'root'")
    expect(NOT_FOUND_SRC).toContain('export function NotFoundPage()')
    expect(NOT_FOUND_SRC).toContain('<DohcLogo')
    expect(NOT_FOUND_SRC).toContain('Open workspace')
    expect(NOT_FOUND_SRC).toContain('Go back')
  })

  it('uses the same 404 when pretty workspace URLs cannot resolve', () => {
    expect(APP_ROUTE_SRC).toContain('<NotFoundPage />')
    expect(APP_ROUTE_SRC).toContain('urlWorkspaceKnown')
    expect(APP_ROUTE_SRC).toContain('routedPage === null')
    expect(APP_ROUTE_SRC).toContain('routedAgentThread === null')
  })
})
