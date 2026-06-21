import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(TEST_DIR, '..', '..')
const REPO = join(TEST_DIR, '..', '..', '..', '..')

// docs/superpowers is intentionally outside this active-source scan. It holds
// migration plans and execution logs that must be able to discuss old app-model
// terms without making shipping code fail the gate.
const SCAN_ROOTS = [
  join(REPO, 'apps'),
  join(REPO, 'packages'),
  join(REPO, 'services'),
  join(REPO, 'docs/security'),
  join(REPO, 'docs/product'),
  join(REPO, 'docs/qa'),
]

const SKIP_DIR = new Set([
  'node_modules',
  '_generated',
  '.output',
  'dist',
  'coverage',
  '.tanstack',
  'codex',
])

const SCANNER = 'siteNoLegacyAppModel.test.ts'
const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|json|md|mdx|svg|html|yml|yaml|txt)$/

const FORBIDDEN: ReadonlyArray<{ name: string; token: string; caseSensitive?: boolean }> = [
  { name: 'legacy hidden site folder', token: '.apps' },
  { name: 'legacy manifest filename', token: 'app.json' },
  { name: 'legacy SDK package', token: '@dohc/app' },
  { name: 'legacy package type', token: 'AppPackage', caseSensitive: true },
  { name: 'legacy source marker', token: 'app-source' },
]

function isHistoricalPath(abs: string): boolean {
  const rel = relative(REPO, abs).replaceAll('\\', '/').toLowerCase()
  return (
    rel.includes('/archive/') ||
    rel.includes('/archived/') ||
    rel.includes('execution-log')
  )
}

function walk(abs: string, out: string[]): void {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(abs)
  } catch {
    return
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIR.has(name)) continue
      walk(join(abs, name), out)
    }
    return
  }
  if (
    st.isFile() &&
    TEXT_EXT.test(abs) &&
    !abs.endsWith(SCANNER) &&
    !isHistoricalPath(abs)
  ) {
    out.push(abs)
  }
}

function collectFiles(): string[] {
  const out: string[] = []
  for (const root of SCAN_ROOTS) walk(root, out)
  return out
}

describe('site no legacy app-model gate', () => {
  it('keeps active source free of legacy app-model tokens', () => {
    const violations: string[] = []
    for (const file of collectFiles()) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (const { name, token, caseSensitive } of FORBIDDEN) {
        const re = new RegExp(
          token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          caseSensitive ? '' : 'i',
        )
        lines.forEach((line, index) => {
          if (re.test(line)) {
            const location = `${relative(REPO, file)}:${index + 1}`
            violations.push(
              `${location} - ${name}: ${line.trim().slice(0, 100)}`,
            )
          }
        })
      }
    }
    expect(violations, `legacy app-model tokens found:\n${violations.join('\n')}`).toEqual([])
  })
})
