import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// dohc rebrand guard — the shipping app must carry NO legacy product
// identity. This recursively scans the app's source, backend, public
// assets, and package metadata and FAILS on any old brand string: the
// old product name, old SDK global, old CSS/key prefixes, old MIME
// type, old env prefix, or the old short brand word.
//
// The final release whitelist is EMPTY: the only file skipped is this
// scanner itself (it necessarily names the forbidden strings). If this
// test ever fails, a legacy identity string slipped into shipping
// source — rename it, do not whitelist it.

const ROOT = process.cwd() // apps/app when vitest runs

// Directories/paths to scan, relative to the app package root.
const SCAN_ROOTS = ['src', 'convex', 'public', 'package.json']

// Never scan generated/build/dependency output, and never scan THIS
// scanner (it has to spell out the forbidden patterns).
const SKIP_DIR = new Set([
  'node_modules',
  '_generated',
  '.output',
  'dist',
  'coverage',
  '.tanstack',
])
const SCANNER = 'brandNoLegacy.test.ts'

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|css|json|md|mdx|svg|html|yml|yaml|txt)$/

// Forbidden legacy-identity patterns. `vibeam` (any case) subsumes the
// old window global, env prefix, MIME type, CSS prefixes, gradient var,
// and component names. `\bbeam\b` / `\bvibe\b` catch the old product
// words on their own.
const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'old product name "vibeam"', re: /vibeam/i },
  { name: 'old product word "beam"', re: /\bbeam\b/i },
  { name: 'old short brand "vibe"', re: /\bvibe\b/i },
]

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
  for (const root of SCAN_ROOTS) walk(join(ROOT, root), out)
  return out
}

describe('brand no-legacy gate', () => {
  it('ships no legacy product identity in src/convex/public/metadata', () => {
    const violations: string[] = []
    for (const file of collectFiles()) {
      const text = readFileSync(file, 'utf8')
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
    const customKernel = readFileSync(
      join(ROOT, 'src/plugins/kernels/CustomKernel.tsx'),
      'utf8',
    )
    expect(customKernel).toContain('window.dohc')

    const fileTree = readFileSync(join(ROOT, 'src/components/FileTree.tsx'), 'utf8')
    expect(fileTree).toContain('application/dohc-tree-row')

    const useTheme = readFileSync(join(ROOT, 'src/lib/use-theme.ts'), 'utf8')
    expect(useTheme).toContain('dohc-theme')
  })
})
