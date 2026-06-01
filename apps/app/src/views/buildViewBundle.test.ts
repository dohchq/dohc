import { describe, expect, it } from 'vitest'
import { buildViewBundle } from './buildViewBundle'

describe('buildViewBundle', () => {
  it('bundles TSX view code with relative imports, CSS, React, and @dohc/view', async () => {
    const result = await buildViewBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: `
            import React from 'react'
            import { createRoot } from 'react-dom/client'
            import { dohc } from '@dohc/view'
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

  it('rejects imports that escape the view package or require unsafe loaders', async () => {
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
    const result = await buildViewBundle({ entry: 'src/App.tsx', files })
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'too-many-files',
          message: 'This view has too many source files to render safely.',
        },
      ],
    })
  })
})

async function expectDiagnostic(source: string, code: string) {
  const result = await buildViewBundle({
    entry: 'src/App.tsx',
    files: [{ relativePath: 'src/App.tsx', body: source }],
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics[0]?.code).toBe(code)
}
