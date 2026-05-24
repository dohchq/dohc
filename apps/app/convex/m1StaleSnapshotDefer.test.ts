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

  it('case B queries components.prosemirrorSync.lib.latestVersion BEFORE patching', () => {
    // The gate must run BEFORE ctx.db.patch in the case B branch.
    // Otherwise the row mutation would land before we have the
    // info needed to defer.
    const caseB = SRC.split('// Case B:')[1]?.split('// Case A:')[0] ?? ''
    expect(caseB).toMatch(/components\.prosemirrorSync\.lib\.latestVersion/)
    // Patch comes AFTER the query in source order.
    const queryIdx = caseB.indexOf('latestVersion')
    const patchIdx = caseB.indexOf('ctx.db.patch')
    expect(queryIdx).toBeGreaterThan(-1)
    expect(patchIdx).toBeGreaterThan(queryIdx)
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

  it('defer path does NOT mutate baseBodyHash, needsRebootstrap, or frozen', () => {
    // The defer's whole point: leave content state alone. The
    // next snapshot will re-evaluate. If we patched baseBodyHash
    // to currentBodyHash here, the next case B would be SKIPPED
    // as already-handled — defeating the purpose. Only
    // scheduledJobId (via buildClearPatch) and updatedAt are
    // touched, both housekeeping.
    const caseB = SRC.split('// Case B:')[1]?.split('// Case A:')[0] ?? ''
    const defer =
      caseB.split('Stale-snapshot defer')[1]?.split('await ctx.db.patch(doc._id, {\n          needsRebootstrap')[0] ?? ''
    expect(defer).not.toMatch(/baseBodyHash:/)
    expect(defer).not.toMatch(/needsRebootstrap:\s*true/)
    expect(defer).not.toMatch(/frozen:\s*true/)
  })

  it('treats latestVersion=null as "no info, proceed" (component empty / missing)', () => {
    // null check guards against the component returning null (no
    // snapshots exist yet) or being temporarily unavailable. We
    // proceed with case B's old behavior in that case — the gate
    // is a SAFETY net, not a required precondition.
    expect(SRC).toMatch(/if \(latest !== null && latest > snapshotVersion\)/)
  })

  it('defer patch routes through buildClearPatch (ownership-conditional)', () => {
    // Same pattern as every other ctx.db.patch site in this
    // handler — spread buildClearPatch() inline. The structural
    // test in m1FixPack365.test.ts pins this convention; defer
    // path must follow it so a later refactor can't introduce a
    // direct scheduledJobId:undefined write that bypasses the
    // ownership check.
    const caseB = SRC.split('// Case B:')[1]?.split('// Case A:')[0] ?? ''
    const defer =
      caseB.split('Stale-snapshot defer')[1]?.split('await ctx.db.patch(doc._id, {\n          needsRebootstrap')[0] ?? ''
    expect(defer).toContain('buildClearPatch()')
    // No direct scheduledJobId write outside buildClearPatch.
    expect(defer).not.toMatch(/scheduledJobId:\s*undefined/)
  })
})
