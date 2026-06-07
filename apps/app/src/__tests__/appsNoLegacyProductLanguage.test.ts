import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP_ROOT = process.cwd()
const REPO_ROOT = join(APP_ROOT, '..', '..')

const ACTIVE_SURFACES = [
  join(REPO_ROOT, 'AGENTS.md'),
  join(REPO_ROOT, 'docs/product/ai-native-positioning.md'),
  join(REPO_ROOT, 'docs/product/transcript-corpus-synthesis.md'),
  join(REPO_ROOT, 'docs/qa/playwright-checklist.md'),
  join(REPO_ROOT, 'docs/views/dohc-top-priorities.html'),
  join(APP_ROOT, 'src/components/AtomEditor.tsx'),
  join(APP_ROOT, 'src/components/FileTree.tsx'),
  join(APP_ROOT, 'src/styles.css'),
]

const LEGACY_APP_LANGUAGE: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'source-backed views', re: /\bsource-backed views\b/i },
  { label: 'live views', re: /\blive views\b/i },
  { label: 'live view', re: /\blive view\b/i },
  { label: 'Views activity', re: /\bViews activity\b/ },
  { label: 'rendered folder view', re: /\brendered folder view\b/i },
  { label: '.views source file', re: /`\.views` source file/i },
  { label: 'view build diagnostic', re: /\bview build diagnostic\b/i },
  { label: 'views folder aria label', re: /['"]views folder['"]/i },
]

describe('apps product language guard', () => {
  it('keeps active docs and user-facing UI on app-first language', () => {
    const violations: string[] = []

    for (const file of ACTIVE_SURFACES) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (const { label, re } of LEGACY_APP_LANGUAGE) {
        lines.forEach((line, index) => {
          if (re.test(line)) {
            violations.push(
              `${relative(APP_ROOT, file)}:${index + 1} — ${label}: ${line.trim()}`,
            )
          }
        })
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })
})
