import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ATOM_VIEW_SRC = readFileSync(
  resolve(__dirname, '../components/AtomView.tsx'),
  'utf8',
)
const APP_SRC = readFileSync(resolve(__dirname, '../routes/_app.tsx'), 'utf8')

describe('view source editing contracts', () => {
  it('opens .views source atoms in source mode by default', () => {
    expect(ATOM_VIEW_SRC).toContain('function isSourceFirstPath')
    expect(ATOM_VIEW_SRC).toContain("parseViewPath(path) !== null")
    expect(ATOM_VIEW_SRC).toContain('/\\.(tsx?|jsx?|css|json)$/i')
    expect(ATOM_VIEW_SRC).toContain('useState(() => isSourceFirstPath(path))')
  })

  it('does not render .html files inside .views as html atoms', () => {
    expect(ATOM_VIEW_SRC).toContain('const isViewSource = viewInfo !== null')
    expect(ATOM_VIEW_SRC).toContain(
      '() => !isViewSource && (!!pathIsHtml || isHtmlAtomBody(draft))',
    )
  })

  it('shows an Open view affordance for .views package source files', () => {
    expect(ATOM_VIEW_SRC).toContain('Open view')
    expect(ATOM_VIEW_SRC).toContain('onOpenView(viewInfo.packageRoot)')
    expect(APP_SRC).toContain('onOpenView={openView}')
  })
})
