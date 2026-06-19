import { describe, expect, it } from 'vitest'
import { runStaticAppCheck } from './staticCheck'
import { runAppTest } from './runAppTest'

const file = (body: string) => [{ relativePath: 'src/App.tsx', body }]

describe('runStaticAppCheck', () => {
  it('passes a clean @dohc/app app with only a compile check', () => {
    const r = runStaticAppCheck(
      file("import { dohc } from '@dohc/app'\nexport default function App(){ return null }"),
    )
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.checks.map((c) => c.name)).toEqual(['compile'])
    expect(r.checks[0]?.status).toBe('ok')
  })

  it('rejects a legacy @dohc/view app', () => {
    const r = runStaticAppCheck(
      file("import { dohc } from '@dohc/view'\nexport default function App(){ return null }"),
    )
    expect(r.ok).toBe(false)
    expect(r.failures[0]?.code).toBe('legacy-view-import')
  })

  it('rejects an app that does not import the @dohc/app SDK', () => {
    const r = runStaticAppCheck(file('export default function App(){ return null }'))
    expect(r.ok).toBe(false)
    expect(r.failures[0]?.code).toBe('missing-app-sdk')
  })

  it('does not accept @dohc/app in comments or strings without a real import', () => {
    const r = runStaticAppCheck(
      file("// import '@dohc/app'\nconst sdk = '@dohc/app'\nexport default function App(){ return null }"),
    )
    expect(r.ok).toBe(false)
    expect(r.failures[0]?.code).toBe('missing-app-sdk')
  })

  it('does not reject @dohc/view text in comments or strings', () => {
    const r = runStaticAppCheck(
      file("import { dohc } from '@dohc/app'\nconst legacy = '@dohc/view'\n// @dohc/view\nexport default function App(){ return null }"),
    )
    expect(r.ok).toBe(true)
  })

  it('rejects legacy SDK usage through dynamic imports', () => {
    const r = runStaticAppCheck(
      file("import { dohc } from '@dohc/app'\nexport async function load(){ return import('@dohc/view') }\nexport default function App(){ return null }"),
    )
    expect(r.ok).toBe(false)
    expect(r.failures[0]?.code).toBe('legacy-view-import')
  })

  it('compiles code files independently so valid multi-file apps pass', () => {
    const r = runStaticAppCheck([
      {
        relativePath: 'src/App.tsx',
        body: "import { dohc } from '@dohc/app'\nexport default function App(){ return null }",
      },
      {
        relativePath: 'src/Widget.tsx',
        body: 'export default function Widget(){ return null }',
      },
    ])
    expect(r.ok).toBe(true)
  })

  it('rejects syntactically broken source that still imports @dohc/app', () => {
    const r = runStaticAppCheck(file("import { dohc } from '@dohc/app'\nconst x = ;"))
    expect(r.ok).toBe(false)
    expect(r.failures[0]?.code).toBe('compile-error')
  })
})

describe('runAppTest static-mode contract', () => {
  it('returns ONLY the compile check — no render/source-data/persistence checks', async () => {
    const r = await runAppTest({
      packageRoot: 'finance/.apps/ledger',
      mode: 'static',
      files: file("import { dohc } from '@dohc/app'\nexport default function App(){ return null }"),
    })
    expect(r.ok).toBe(true)
    expect(r.checks.map((c) => c.name)).toEqual(['compile'])
  })
})
