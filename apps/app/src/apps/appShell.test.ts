import { describe, expect, it } from 'vitest'
import { APP_SHELL_CSP, buildAppShell } from './appShell'

describe('app runtime shell', () => {
  it('declares the fixed no-network CSP used by sandboxed apps', () => {
    expect(APP_SHELL_CSP).toContain("default-src 'none'")
    expect(APP_SHELL_CSP).toContain("script-src 'unsafe-inline'")
    expect(APP_SHELL_CSP).toContain("connect-src 'none'")
    expect(APP_SHELL_CSP).toContain("form-action 'none'")
    expect(APP_SHELL_CSP).not.toContain('allow-same-origin')
  })

  it('builds a fixed shell with a root element and postMessage SDK bootstrap', () => {
    const html = buildAppShell({
      title: 'Client Portal',
      script: 'window.__appStarted = true',
    })

    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('window.dohc')
    expect(html).toContain('collection: (name) =>')
    expect(html).toContain('doc: (path) =>')
    expect(html).toContain('database: (path) =>')
    expect(html).toContain("parent.postMessage({ type: 'dohc.ready' }, '*')")
    expect(html).toContain('window.__appStarted = true')
    expect(html).not.toContain('<script src=')
  })

  it('escapes title text before interpolation', () => {
    const html = buildAppShell({ title: '<img src=x onerror=1>' })
    expect(html).toContain('&lt;img src=x onerror=1&gt;')
    expect(html).not.toContain('<img src=x onerror=1>')
  })

  it('escapes raw script end tags before interpolation', () => {
    const html = buildAppShell({
      title: 'Safe',
      script: `window.payload = '</script><img src=x onerror=1>'`,
    })

    expect(html).toContain('<\\/script><img src=x onerror=1>')
    expect(html).not.toContain("window.payload = '</script>")
  })

  it('only accepts SDK responses from the parent window', () => {
    const html = buildAppShell({ title: 'Bridge' })
    expect(html).toContain('if (event.source !== parent) return')
  })
})
