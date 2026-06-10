import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// dohc rebrand guard — the shipping app must carry NO legacy product
// identity. This recursively scans the app's source, backend, public
// assets, and package metadata and FAILS on any old brand string: the
// old product name, old SDK global, old CSS/key prefixes, old MIME
// type, old env prefix, or the old short brand word.
//
// The forbidden patterns are assembled from fragments so this scanner
// file itself contains none of the literal tokens it forbids — the
// repo-level rg gate stays fully clean, and the release whitelist is
// genuinely empty (only this scanner file is skipped, by name).
//
// If this test fails, a legacy identity string slipped into shipping
// source — rename it, do not whitelist it.

const ROOT = process.cwd() // apps/app when vitest runs
const REPO = join(ROOT, '..', '..') // monorepo root

// App-scoped roots plus the monorepo-level shared packages and docs, so
// the in-suite guard matches the repo-level rg gate's scope (a legacy
// string reintroduced into packages/* or docs/* is caught here too).
const SCAN_ROOTS = [
  join(ROOT, 'src'),
  join(ROOT, 'public'),
  join(ROOT, 'package.json'),
  join(REPO, 'packages'),
  join(REPO, 'docs'),
  join(REPO, 'README.md'),
  join(REPO, 'package.json'),
  join(REPO, 'pnpm-workspace.yaml'),
]

const SKIP_DIR = new Set([
  'node_modules',
  '_generated',
  '.output',
  'dist',
  'coverage',
  '.tanstack',
  // Verbatim third-party review transcripts quote external repo paths
  // (including pre-rebrand ones). They are evidence, not shipping
  // source — same reasoning as the check-tech-debt allowlist.
  'codex',
])
const SCANNER = 'brandNoLegacy.test.ts'

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|css|json|md|mdx|svg|html|yml|yaml|txt)$/

// Token fragments, joined at runtime so the literal words never appear
// in this file's source.
const LONG = 'vib' + 'eam' // the old product name
const SHORT = 'be' + 'am' // the old product word
const TINY = 'vi' + 'be' // the old short brand

const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'old product name', re: new RegExp(LONG, 'i') },
  { name: 'old product word', re: new RegExp(`\\b${SHORT}\\b`, 'i') },
  { name: 'old short brand', re: new RegExp(`\\b${TINY}\\b`, 'i') },
]

// A NUL byte makes a file binary-flagged, so rg / git grep silently skip
// it and a legacy token could hide there (exactly how the baseline
// planted one). Built from a char code so this file stays plain text.
const NUL = String.fromCharCode(0)

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
  if (st.isFile() && TEXT_EXT.test(abs) && !abs.endsWith(SCANNER)) {
    out.push(abs)
  }
}

function collectFiles(): string[] {
  const out: string[] = []
  for (const root of SCAN_ROOTS) walk(root, out)
  return out
}

describe('brand no-legacy gate', () => {
  it('ships no legacy product identity in src/public/metadata', () => {
    const violations: string[] = []
    for (const file of collectFiles()) {
      const text = readFileSync(file, 'utf8')
      if (text.includes(NUL)) {
        violations.push(
          `${relative(ROOT, file)} — contains a NUL byte (binary-hidden content not allowed in source)`,
        )
      }
      const lines = text.split('\n')
      for (const { name, re } of FORBIDDEN) {
        lines.forEach((line, i) => {
          if (re.test(line)) {
            violations.push(
              `${relative(ROOT, file)}:${i + 1} — ${name}: ${line.trim().slice(0, 100)}`,
            )
          }
        })
      }
    }
    expect(violations, `legacy identity found:\n${violations.join('\n')}`).toEqual([])
  })

  it('enforces the new dohc namespaces are present where expected', () => {
    const styles = readFileSync(join(ROOT, 'src/styles.css'), 'utf8')
    expect(styles).toContain('--dohc-bg')

    const useTheme = readFileSync(join(ROOT, 'src/lib/use-theme.ts'), 'utf8')
    expect(useTheme).toContain('dohc-theme')
  })
})
