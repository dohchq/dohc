import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../src')

const PRODUCTION_EXTENSIONS = new Set(['.ts', '.tsx'])
const TEST_OR_STORY_RE = /(?:\.test|\.spec|\.stories)\.(?:ts|tsx)$/
const BROWSER_DIALOG_RE =
  /(?:\b(?:window|globalThis|self)\.)?\b(?:alert|confirm|prompt)\s*\(/g

function stripComments(source: string) {
  let out = ''
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' =
    'code'
  let escaped = false

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    const next = source[i + 1]

    if (state === 'line-comment') {
      if (ch === '\n') {
        out += ch
        state = 'code'
      }
      continue
    }

    if (state === 'block-comment') {
      if (ch === '\n') out += ch
      if (ch === '*' && next === '/') {
        i++
        state = 'code'
      }
      continue
    }

    out += ch

    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code'
      }
      continue
    }

    if (ch === '/' && next === '/') {
      out = out.slice(0, -1)
      i++
      state = 'line-comment'
    } else if (ch === '/' && next === '*') {
      out = out.slice(0, -1)
      i++
      state = 'block-comment'
    } else if (ch === "'") {
      state = 'single'
    } else if (ch === '"') {
      state = 'double'
    } else if (ch === '`') {
      state = 'template'
    }
  }

  return out
}

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
  it('matches browser dialog calls across common global forms', () => {
    expect(
      [
        'alert("x")',
        'window.confirm("x")',
        'globalThis.prompt("x")',
        'self.alert("x")',
      ].flatMap((source) => source.match(BROWSER_DIALOG_RE) ?? []),
    ).toEqual(['alert(', 'window.confirm(', 'globalThis.prompt(', 'self.alert('])
  })

  it('keeps // inside strings from hiding later dialog calls on the same line', () => {
    const source = 'const url = "https://dohc.app//docs"; alert("blocked") // trailing'

    expect(stripComments(source)).toContain('https://dohc.app//docs')
    expect(stripComments(source).match(BROWSER_DIALOG_RE)).toEqual(['alert('])
  })

  it('does not call alert, confirm, or prompt in production source', () => {
    const offenders = productionFiles(ROOT).flatMap((path) => {
      const source = stripComments(readFileSync(path, 'utf8'))
      const matches = source.match(BROWSER_DIALOG_RE) ?? []
      return matches.map((match) => `${relative(ROOT, path)}: ${match}`)
    })

    expect(offenders).toEqual([])
  })
})
