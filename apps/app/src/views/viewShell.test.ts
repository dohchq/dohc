import { describe, expect, it } from 'vitest'
import { buildViewShell, VIEW_SHELL_CSP } from './viewShell'

describe('view runtime shell', () => {
  it('declares the fixed no-network CSP used by sandboxed views', () => {
    expect(VIEW_SHELL_CSP).toContain("default-src 'none'")
    expect(VIEW_SHELL_CSP).toContain("script-src 'unsafe-inline'")
    expect(VIEW_SHELL_CSP).toContain("connect-src 'none'")
    expect(VIEW_SHELL_CSP).toContain("form-action 'none'")
    expect(VIEW_SHELL_CSP).not.toContain('allow-same-origin')
  })

  it('builds a fixed shell with a root element and postMessage SDK bootstrap', () => {
    const html = buildViewShell({
      title: 'Client Portal',
      script: 'window.__viewStarted = true',
    })

    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('window.dohc')
    expect(html).toContain("parent.postMessage({ type: 'dohc.ready' }, '*')")
    expect(html).toContain('window.__viewStarted = true')
    expect(html).not.toContain('<script src=')
  })

  it('escapes title text before interpolation', () => {
    const html = buildViewShell({ title: '<img src=x onerror=1>' })
    expect(html).toContain('&lt;img src=x onerror=1&gt;')
    expect(html).not.toContain('<img src=x onerror=1>')
  })
})
