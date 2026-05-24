/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// M1 step 3.8.1.5 — codex 7th-pass [P1] #2 SERVER FIX.
//
// Case B (auto-rebuild) is decided from snapshotContent. Between
// snapshot commit and projection scheduler firing, more deltas
// can land via submitSteps. snapshotContent then represents
// STALE PM state; newDerivedHash captures that stale state. The
// case B condition can spuriously match when the user has
// unprojected edits past the snapshot. Setting needsRebootstrap
// in that case + the client's auto-reload = silent data loss.
//
// The fix: before case B fires, query latestVersion. If
// latestVersion > snapshotVersion, defer (return
// skipped:'snapshot-stale'). The next snapshot's projection
// re-evaluates with fresh data.
//
// Behavioral testing for this race is hard to set up
// deterministically in convex-test (the onSnapshot scheduler
// races with our explicit projection calls). The existing case B
// test (m1ConflictResolver.test.ts) verifies normal-path case B
// still works after the gate (latestVersion query reachable, no
// regression). This file is the structural pin — refactors can't
// quietly remove the gate without these failing.

const SRC = readFileSync(
  resolve(__dirname, './collabProjection.ts'),
  'utf8',
)

describe('M1 step 3.8.1.5 — server-side stale-snapshot defer', () => {
  it('imports components from _generated/api for the latestVersion query', () => {
    expect(SRC).toMatch(
      /import \{ components, internal \} from '\.\/_generated\/api'/,
    )
  })

  it('gate hoisted to top of conflict classification (3.8.1.7 P2 #4)', () => {
    // 3.8.1.5 originally placed the latestVersion check inside
    // case B only. Codex 8th-pass [P2] #4: case A FREEZE can
    // ALSO fire spuriously on a stale snapshot — newDerivedHash
    // (from stale snapshotContent) wouldn't match currentBodyHash
    // even though the actual PM might. 3.8.1.7 hoists the gate
    // ABOVE all case-A/B/C analysis: every classification sees
    // fresh information or defers.
    //
    // Source position: gate runs BEFORE newDerivedHash is even
    // computed (because none of the cases need to fire if
    // snapshot is stale).
    const conflict =
      SRC.split('currentBodyHash !== doc.baseBodyHash')[1]?.split(
        '// Case C:',
      )[0] ?? ''
    expect(conflict).toMatch(/components\.prosemirrorSync\.lib\.latestVersion/)
    expect(conflict).toMatch(/codex 8th-pass \[P2\] #4/i)
    // Gate fires BEFORE newDerivedHash computation.
    const gateIdx = conflict.indexOf('latestVersion')
    const derivedIdx = conflict.indexOf('newDerivedHash = await')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(derivedIdx).toBeGreaterThan(gateIdx)
  })

  it('defers with skipped:snapshot-stale when latestVersion > snapshotVersion', () => {
    expect(SRC).toMatch(/latest > snapshotVersion/)
    expect(SRC).toMatch(/skipped:\s*'snapshot-stale'/)
    // Return value carries snapshotVersion + latestVersion for
    // operator/log visibility (you want to know how stale the
    // snapshot was).
    expect(SRC).toMatch(
      /skipped:\s*'snapshot-stale'[\s\S]+?snapshotVersion[\s\S]+?latestVersion/,
    )
  })

  it('defer path patches only housekeeping (no content fields)', () => {
    // The defer's whole point: leave content state alone. Only
    // scheduledJobId (via buildClearPatch) + updatedAt change.
    // If we patched baseBodyHash to currentBodyHash here, the
    // next case B would be SKIPPED as already-handled, defeating
    // the purpose.
    const conflict =
      SRC.split('currentBodyHash !== doc.baseBodyHash')[1]?.split(
        '// Case C:',
      )[0] ?? ''
    const defer = conflict.split('latest > snapshotVersion')[1]?.split('}')[0] ?? ''
    expect(defer).not.toMatch(/baseBodyHash:\s*currentBodyHash/)
    expect(defer).not.toMatch(/needsRebootstrap:\s*true/)
    expect(defer).not.toMatch(/frozen:\s*true/)
    expect(defer).toContain('buildClearPatch()')
  })

  it('treats latestVersion=null as "no info, proceed" (component empty / missing)', () => {
    // null check guards against the component returning null (no
    // snapshots exist yet) or being temporarily unavailable. We
    // proceed with the case A/B/C analysis in that case — the
    // gate is a SAFETY net, not a required precondition.
    expect(SRC).toMatch(/if \(latest !== null && latest > snapshotVersion\)/)
  })
})
