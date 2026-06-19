// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_DOWNLOAD_URL,
  InstallDesktopPrompt,
} from '../components/InstallDesktopPrompt'

// Phase 12 — web repositioning. dohc on the web is the CLOUD client: a browser
// workspace on any device, with shared links. It is NOT the local-files client
// (that is the desktop app) and must never claim to be. These assertions pin
// that role so a regression that re-frames the web as a local file manager —
// or drops the "get the desktop app" affordance — fails the build.

const APP_ROOT = process.cwd() // apps/web when vitest runs here

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

describe('web is the dohc Cloud client', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('prompts the user to install the desktop app for local folders + agents', () => {
    act(() => {
      root.render(<InstallDesktopPrompt />)
    })
    expect(container.querySelector('[data-testid="install-desktop-prompt"]')).not.toBeNull()
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="install-desktop-link"]')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe(DESKTOP_DOWNLOAD_URL)
    // Pin the exact origin+path (D-37): the URL is a deliberate pre-launch
    // placeholder — any change (or typo-squat) must be a conscious edit here.
    expect(DESKTOP_DOWNLOAD_URL).toBe('https://dohc.app/desktop')
    // It positions the web as cloud and points local-folder/agent work to desktop.
    expect(container.textContent ?? '').toMatch(/dohc Cloud/i)
    expect(container.textContent ?? '').toMatch(/local folders|local-first|agents/i)

    // And the affordance is actually WIRED into the product, not just a unit:
    // the signed-out splash in _app.tsx must render it. Removing that one line
    // must fail this build (same file-pinning style as the false-claims test).
    const appRoute = readFileSync(join(APP_ROOT, 'src/routes/_app.tsx'), 'utf8')
    expect(appRoute).toMatch(/<InstallDesktopPrompt\b/)
  })

  it('makes no local-filesystem CLAIM on its user-facing surfaces', () => {
    // A cloud web client must never claim to read/write files on the user's own
    // disk — that is the desktop app's job. Guard the entry/marketing surfaces.
    const surfaces = [
      'src/routes/_app.tsx',
      'src/routes/__root.tsx',
      'src/components/InstallDesktopPrompt.tsx',
    ].map((p) => join(APP_ROOT, p))
    const FALSE_LOCAL_CLAIMS = [
      /files? (?:on|stored on) your (?:disk|computer|device|machine)/i,
      /open (?:a )?(?:local )?folder on your (?:computer|disk|machine)/i,
      /reads? your local files/i,
      /your files (?:live|are stored) on your (?:disk|computer|device)/i,
    ]
    const violations: string[] = []
    for (const file of surfaces) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const re of FALSE_LOCAL_CLAIMS) {
            if (re.test(line)) violations.push(`${file}:${i + 1} — ${line.trim()}`)
          }
        })
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('serves cloud workspace access + shared links and is mobile-friendly', () => {
    const routes = join(APP_ROOT, 'src/routes')
    // Cloud workspace access + both shared-link surfaces exist.
    expect(existsSync(join(routes, '_app.$workspaceSlug.tsx'))).toBe(true)
    expect(existsSync(join(routes, '_app.shared.$shareId.tsx'))).toBe(true)
    expect(existsSync(join(routes, 'r/$atomId.tsx'))).toBe(true)
    // Mobile-friendly viewing: a responsive viewport is declared at the root
    // (TanStack head() meta object: { name: 'viewport', content: 'width=device-width…' }).
    const rootSource = readFileSync(join(routes, '__root.tsx'), 'utf8')
    expect(rootSource).toMatch(/['"]viewport['"]/)
    expect(rootSource).toMatch(/width=device-width/)
  })

  it('is a pure cloud/browser client — never bundles an Electron/desktop runtime', () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const desktopDeps = Object.keys(deps).filter(
      (name) => name === 'electron' || name.startsWith('electron-') || name === '@dohc/desktop',
    )
    expect(desktopDeps, desktopDeps.join(', ')).toEqual([])
  })
})
