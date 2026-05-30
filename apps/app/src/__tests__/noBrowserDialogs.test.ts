import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '../../src')

const PRODUCTION_EXTENSIONS = new Set(['.ts', '.tsx'])
const TEST_OR_STORY_RE = /(?:\.test|\.spec|\.stories)\.(?:ts|tsx)$/
const BROWSER_DIALOG_RE =
  /\bwindow\.(?:alert|confirm|prompt)\s*\(/g

function extensionOf(path: string) {
  const match = /\.[^.]+$/.exec(path)
  return match?.[0] ?? ''
}

function productionFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      productionFiles(path).forEach((child) => out.push(child))
      continue
    }
    if (!PRODUCTION_EXTENSIONS.has(extensionOf(path))) continue
    if (TEST_OR_STORY_RE.test(path)) continue
    out.push(path)
  }
  return out
}

describe('app production UX avoids browser dialogs', () => {
  it('does not call alert, confirm, or prompt in production source', () => {
    const offenders = productionFiles(ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      const matches = source.match(BROWSER_DIALOG_RE) ?? []
      return matches.map((match) => `${relative(ROOT, path)}: ${match}`)
    })

    expect(offenders).toEqual([])
  })
})
