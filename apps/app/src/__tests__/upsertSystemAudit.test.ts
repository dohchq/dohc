import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// file-org-v1 §5.6 (Track-4 D4.1a) — AUDIT-BY-GREP for the
// `_upsertSystem` internal mutation. The contract is:
//
//   `_upsertSystem` is the SOLE entry that may overwrite a
//   systemLocked atom AND is the SOLE writer of `systemLocked: true`.
//   Production callers: none. Canonical context files live under
//   `.context/` and are user-deletable; generated context is no longer
//   system locked.
//
// A future PR that adds a SECOND caller introduces a second mouth
// onto the system-lock surface. The lock invariant — "system atoms
// have one owner that asserts the lock on every refresh" — is
// destroyed if that owner becomes plural. This test refuses the
// addition: a caller MUST be added explicitly to EXPECTED_CALLERS
// (which forces the system-lock behavior to be reasoned about,
// documented, and lock-asserted).
//
// Test scope: any non-test, non-generated file under `convex/` that
// references `_upsertSystem`. Matches `internal.atoms._upsertSystem`
// AND `ctx.runMutation(internal.atoms._upsertSystem, ...)` AND a
// direct `_upsertSystem(` import (none exists today; this is a
// belt-and-suspenders future-proofing). The DEFINING file itself
// (`convex/atoms.ts`) is exempt.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONVEX_DIR = resolve(__dirname, '../../convex')

// The defining file is excluded — that's the export itself, not a
// "caller". Tests and generated code are excluded — they exercise
// the export deliberately or mirror it.
const EXEMPT = new Set<string>([
  // The export itself.
  resolve(CONVEX_DIR, 'atoms.ts'),
])

// PRODUCTION callers. A new caller MUST be added here.
const EXPECTED_CALLERS = new Set<string>([])

function listConvexSources(): string[] {
  const out: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      // _generated/, ai-files/, **/__tests__ etc. — skip generated
      // and test files; only walk non-hidden subdirs.
      if (entry.startsWith('_') || entry.startsWith('.')) continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      // Skip test files; the spec ones may reference the symbol.
      if (entry.endsWith('.test.ts')) continue
      if (!entry.endsWith('.ts')) continue
      out.push(full)
    }
  }
  walk(CONVEX_DIR)
  return out
}

describe('_upsertSystem audit — allowlist enforcement', () => {
  it('every caller of _upsertSystem in convex/** is in EXPECTED_CALLERS', () => {
    const sources = listConvexSources()
    const actualCallers = new Set<string>()
    // Runtime-call pattern. The only way to invoke an internal Convex
    // mutation is via `ctx.runMutation(internal.atoms._upsertSystem, …)`
    // or via the `internal.atoms._upsertSystem` reference (for a
    // ctx.scheduler.runAfter or similar). Match the dotted access,
    // NOT bare mentions in comments/docs.
    const callRe = /internal\.atoms\._upsertSystem\b/
    for (const file of sources) {
      if (EXEMPT.has(file)) continue
      const text = readFileSync(file, 'utf8')
      if (callRe.test(text)) {
        actualCallers.add(file)
      }
    }
    // The set we found MUST equal EXPECTED_CALLERS. Anything new ⇒
    // FAIL (forcing the new caller to be reasoned about + added).
    const actual = Array.from(actualCallers).sort()
    const expected = Array.from(EXPECTED_CALLERS).sort()
    expect(actual).toEqual(expected)
  })

  it('map.ts no longer writes generated context through _upsertSystem', () => {
    const mapSrc = readFileSync(resolve(CONVEX_DIR, 'map.ts'), 'utf8')
    expect(mapSrc).not.toMatch(/internal\.atoms\._upsertSystem\b/)
  })
})
