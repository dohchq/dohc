import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) =>
  readFileSync(resolve(__dirname, '../../src/', rel), 'utf8')

const ATOM_VIEW = read('components/AtomView.tsx')
const HTML_FRAME = read('components/HtmlAtomFrame.tsx')

describe('HTML atom layout', () => {
  it('renders HTML view mode outside the centered document page column', () => {
    expect(ATOM_VIEW).toContain('const shellClassName = isHtml && !sourceMode')
    expect(ATOM_VIEW).toContain("'dohc-html-shell'")
    expect(ATOM_VIEW).toContain("'doc doc-editing'")
    expect(ATOM_VIEW).toMatch(/<div className=\{shellClassName\}>/)
  })

  it('keeps the full-size HTML iframe unframed unless used as a compact preview', () => {
    expect(HTML_FRAME).toContain(
      "compact ? 'h-[280px] rounded-md border border-rule bg-page' : 'h-full min-h-[calc(100vh-44px)]'",
    )
    expect(HTML_FRAME).toContain('className={`relative w-full overflow-hidden ${frameClassName}`}')
  })
})
