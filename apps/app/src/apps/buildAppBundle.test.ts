import { describe, expect, it } from 'vitest'
import { buildAppBundle } from './buildAppBundle.server'
import { validateBundleAppInput } from './buildAppBundle.functions'

describe('buildAppBundle', () => {
  it('bundles TSX app code with relative imports, CSS, React, and @dohc/app', async () => {
    const result = await buildAppBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: `
            import React from 'react'
            import { createRoot } from 'react-dom/client'
            import { dohc } from '@dohc/app'
            import './styles.css'
            import { label } from './label'
            function App() {
              return <button onClick={() => dohc.source.open({ path: 'tasks.md' })}>{label}</button>
            }
            createRoot(document.getElementById('root')!).render(<App />)
          `,
        },
        {
          relativePath: 'src/label.ts',
          body: `export const label = 'Open'`,
        },
        {
          relativePath: 'src/styles.css',
          body: `button { color: red; }`,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.code).toContain('Open')
      expect(result.code).toContain('button { color: red; }')
      expect(result.code).toContain('dohc')
    }
  })

  it('keeps @dohc/view as a temporary migration alias with a warning', async () => {
    const result = await buildAppBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: `
            import { dohc } from '@dohc/view'
            export default function App() {
              return <button onClick={() => dohc.source.open({ path: 'tasks.md' })}>Open</button>
            }
          `,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.code).toContain('@dohc/view is deprecated; use @dohc/app')
  })

  it('auto-mounts a default React export into the app root', async () => {
    const result = await buildAppBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: `
            import React from 'react'
            export default function App() {
              return <main>Auto-mounted workspace app</main>
            }
          `,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.code).toContain('Auto-mounted workspace app')
      expect(result.code).toMatch(/getElementById\(["']root["']\)/)
      expect(result.code).toContain('createRoot')
    }
  })

  it('runs default-export TSX apps without requiring an explicit React import', async () => {
    const result = await buildAppBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: `
            export default function App() {
              return <main>No React import needed</main>
            }
          `,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.code).toContain('No React import needed')
  })

  it('strips dohc atom frontmatter before compiling source files', async () => {
    const result = await buildAppBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: `---
id: apps.workspace.src.app
---
import React from 'react'
import './styles.css'
export default function App() {
  return <main>Frontmatter-safe app</main>
}
`,
        },
        {
          relativePath: 'src/styles.css',
          body: `---
id: apps.workspace.src.styles
---
main { color: green; }
`,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.code).toContain('Frontmatter-safe app')
      expect(result.code).toContain('main { color: green; }')
      expect(result.code).not.toContain('apps.workspace.src.app')
    }
  })

  it('rejects imports that escape the app package or require unsafe loaders', async () => {
    await expectDiagnostic(
      `import x from '/etc/passwd'; console.log(x)`,
      'absolute-import',
    )
    await expectDiagnostic(
      `import fs from 'fs'; console.log(fs)`,
      'unsupported-import',
    )
    await expectDiagnostic(
      `import('https://example.com/app.js')`,
      'dynamic-import',
    )
  })

  it('returns diagnostics instead of rendering oversized packages', async () => {
    const files = Array.from({ length: 101 }, (_, index) => ({
      relativePath: `src/${index}.ts`,
      body: `export const x${index} = ${index}`,
    }))
    files.push({ relativePath: 'src/App.tsx', body: 'console.log(1)' })
    const result = await buildAppBundle({ entry: 'src/App.tsx', files })
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'too-many-files',
          message: 'This app has too many source files to render safely.',
        },
      ],
    })
  })

  it('uses app-facing language for invalid server bundle input', () => {
    expect(() => validateBundleAppInput(null)).toThrow('Invalid app bundle input.')
    expect(() => validateBundleAppInput({ entry: 42, files: [] })).toThrow('Invalid app entry.')
    expect(() => validateBundleAppInput({ entry: 'src/App.tsx', files: 'nope' })).toThrow('Invalid app files.')
    for (const badInput of [
      null,
      { entry: 42, files: [] },
      { entry: 'src/App.tsx', files: 'nope' },
    ]) {
      try {
        validateBundleAppInput(badInput)
      } catch (cause) {
        expect(cause).toBeInstanceOf(Error)
        expect((cause as Error).message.toLowerCase()).not.toContain('view')
      }
    }
  })
})

async function expectDiagnostic(source: string, code: string) {
  const result = await buildAppBundle({
    entry: 'src/App.tsx',
    files: [{ relativePath: 'src/App.tsx', body: source }],
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics[0]?.code).toBe(code)
}
