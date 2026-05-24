/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(
  resolve(__dirname, '../components/AtomEditor.tsx'),
  'utf8',
)

// M1 step 2 (multiplayer-and-h-followups §8) — structural pins on
// the AtomEditor wiring for prosemirror-sync. End-to-end multiplayer
// requires a Convex dev deploy + two browser windows; what we CAN
// pin here is that:
//   - the multiplayer prop exists + threads through to the inner
//     CrepeEditor
//   - the collab-sync hooks are called only when the prop is set
//     (single-user behavior is byte-identical when the prop is
//     unset — every other CallSite stays unaffected)
//   - the post-mount install + remote-pull effects are gated by
//     `multiplayerDocId` so they early-return for non-multiplayer
//   - the remote-pull dispatch is deferred to a microtask (PM
//     forbids reentrant dispatches during render)

describe('AtomEditor — multiplayer wiring (structural)', () => {
  it('exposes multiplayerDocId on the public Props', () => {
    expect(SRC).toMatch(/multiplayerDocId\?: string/)
    // The docstring labels the v1 limitation explicitly so a
    // future reader knows about the brief mount-time divergence.
    expect(SRC).toMatch(/V1 LIMITATION/i)
  })

  it('threads multiplayerDocId to CrepeEditor (the inner component)', () => {
    // CrepeEditorProps shape includes it.
    expect(SRC).toContain('multiplayerDocId?: string')
    // The render call passes it through.
    expect(SRC).toMatch(/<CrepeEditor[\s\S]*?multiplayerDocId=\{multiplayerDocId\}/)
  })

  it('calls useCollabSync inside CrepeEditor with enabled gated by multiplayerDocId', () => {
    // The hook is invoked with the right gating shape; passing
    // enabled:false (when the prop is unset) means useCollabSync
    // short-circuits the bootstrap + returns no plugins.
    expect(SRC).toContain('useCollabSync({')
    expect(SRC).toMatch(/enabled:\s*!!multiplayerDocId/)
    expect(SRC).toMatch(/docId:\s*multiplayerDocId \?\? null/)
  })

  it('uses a ref to bridge collab plugins into the useEditor closure', () => {
    // useEditor's closure runs ONCE at mount. Capturing the
    // plugins via a ref lets the closure pick them up if they're
    // ready, and the late-install effect handles the case where
    // they arrive after.
    expect(SRC).toContain('collabPluginsRef.current = collabSync.plugins')
    // The closure reads from the ref when building `extra`.
    expect(SRC).toMatch(/if \(collabPluginsRef\.current\)/)
    expect(SRC).toMatch(/for \(const p of collabPluginsRef\.current\)/)
  })

  it('late-install effect adds collab plugins post-mount via prosePluginsCtx', () => {
    // The bootstrap may resolve AFTER the editor mounts; this
    // effect folds the plugins in then. Idempotent via setHas.
    expect(SRC).toMatch(/late install of collab plugins/i)
    expect(SRC).toMatch(/ctx\.update\(prosePluginsCtx,/)
    expect(SRC).toContain('setHas.has(p)')
  })

  it('remote-pull effect: gated, microtask-deferred, applies via receiveTransaction', () => {
    // The effect must early-return when multiplayerDocId is
    // unset; this guarantees zero multiplayer code runs for
    // single-user callers. The microtask defer (`void (async`)
    // prevents reentrant dispatches into the editor.
    expect(SRC).toMatch(/remote-pull loop/i)
    expect(SRC).toMatch(/if \(!multiplayerDocId\) return/)
    expect(SRC).toMatch(/void \(async \(\) => \{/)
    // Calls our applyRemoteSteps helper with the resolved view.
    expect(SRC).toContain('applyRemoteSteps({')
  })

  it('failure modes: auth revocation / outage leave the editor alone', () => {
    // No-op catch is intentional — pending steps live in the
    // collab plugin's state; the next version bump retries.
    expect(SRC).toMatch(/Auth revocation or transient outage/)
  })

  it('does not touch the single-user fast path (no Convex calls for non-multiplayer)', () => {
    // The collab hooks MUST be gated. useCollabSync gates via
    // enabled:!!multiplayerDocId; useRemoteVersion gates via
    // multiplayerDocId??null; useCollabDocState (3.8.1.0+) gates
    // via multiplayerDocId??null + the 'skip' idiom inside the hook.
    // Each is called EXACTLY ONCE in the file (no duplicate
    // subscriptions). Hook source pins are in collabSync.test.ts.
    const useCollabSyncCount = (SRC.match(/useCollabSync\(/g) ?? []).length
    expect(useCollabSyncCount).toBe(1)
    const useRemoteVersionCount = (SRC.match(/useRemoteVersion\(/g) ?? [])
      .length
    expect(useRemoteVersionCount).toBe(1)
    const useCollabDocStateCount = (
      SRC.match(/useCollabDocState\(/g) ?? []
    ).length
    expect(useCollabDocStateCount).toBe(1)
  })
})

// M1 step 3.8.1.1 — frozen banner. Renders in place of the
// editor when collab-doc state says frozen=true (3.7 case A;
// both sides changed unilaterally). Gated by multiplayerDocId
// so single-user mounts never hit this path.
describe('AtomEditor — frozen banner (M1 3.8.1.1)', () => {
  it('imports useCollabDocState from collab-sync', () => {
    expect(SRC).toMatch(
      /import\s*\{[\s\S]*?useCollabDocState[\s\S]*?\}\s*from\s*'@\/lib\/collab-sync'/,
    )
  })

  it('gates the banner on multiplayerDocId (single-user never sees it)', () => {
    // The banner conditional MUST start with multiplayerDocId
    // check — otherwise single-user editors could hit it if
    // collabDocState ever ended up populated stray.
    expect(SRC).toMatch(
      /if\s*\(\s*multiplayerDocId\s*&&[\s\S]+?collabDocState[\s\S]+?\.frozen\s*\)/,
    )
  })

  it('banner has accessible role + testid + reload button', () => {
    // Accessibility: role="alert" so screen readers announce it
    // when state flips. Testid for downstream UI tests. Reload
    // triggers window.location.reload (v1 simplest — later can
    // be more graceful via a fresh useCollabSync mount cycle).
    expect(SRC).toMatch(/data-testid="collab-frozen-banner"/)
    expect(SRC).toMatch(/role="alert"/)
    expect(SRC).toMatch(/onClick=\{\(\) => window\.location\.reload\(\)\}/)
  })

  it('banner narrative names both warning + consequence (real conflict UX)', () => {
    // The user copy needs to explain WHY (someone else edited)
    // AND WHAT'S LOST (unsaved changes in this session). Without
    // both, users will hit reload without understanding what
    // they're losing.
    expect(SRC).toMatch(/changed outside.*collaborative session/i)
    expect(SRC).toMatch(/unsaved.*lost|lose.*unsaved|will be lost/i)
  })

  it('banner exists check uses the discriminated union correctly', () => {
    // CollabDocState is `{exists:false} | {exists:true, frozen, ...}`
    // — the frozen field only exists on the exists:true variant.
    // The conditional must include the exists:true check so TS
    // narrows + runtime doesn't crash on the false variant.
    expect(SRC).toMatch(/'exists' in collabDocState[\s\S]+?collabDocState\.exists/)
    expect(SRC).toMatch(/collabDocState\.frozen/)
  })
})

// M1 step 3.8.1.2 — rebootstrap auto-reload overlay. When the
// conflict resolver (3.7 case B) flags needsRebootstrap=true,
// show a brief "Updating..." overlay + auto-reload via
// window.location.reload(). Reload triggers fresh AtomEditor
// mount → fresh useCollabSync → bootstrap mutation fires →
// server clears the flag.
describe('AtomEditor — rebootstrap overlay (M1 3.8.1.2)', () => {
  it('overlay has accessible role="status" + aria-live="polite"', () => {
    // Status role + polite live region: announces to screen
    // readers when the overlay appears WITHOUT interrupting
    // (which would happen with role="alert" / aria-live=assertive).
    // The overlay is transient + informational, not a warning.
    expect(SRC).toMatch(/data-testid="collab-rebootstrap-overlay"/)
    expect(SRC).toMatch(/role="status"/)
    expect(SRC).toMatch(/aria-live="polite"/)
  })

  it('auto-reload uses setTimeout + window.location.reload', () => {
    // The 1500ms delay lets the user see the explanatory text
    // before reload kicks in. Cleanup via clearTimeout in case
    // the component unmounts before the timer fires (e.g. user
    // navigates away).
    expect(SRC).toMatch(/setTimeout\([\s\S]*?window\.location\.reload\(\)[\s\S]*?,\s*1500\s*\)/)
    expect(SRC).toMatch(/return\s*\(\)\s*=>\s*clearTimeout\(t\)/)
  })

  it('overlay + auto-reload effect both gated by multiplayerDocId', () => {
    // BOTH the render branch AND the useEffect must check
    // multiplayerDocId first — otherwise single-user mounts could
    // theoretically hit them if collabDocState ever populated stray.
    // The auto-reload effect's first line MUST be the gate.
    expect(SRC).toMatch(
      /if\s*\(\s*multiplayerDocId\s*&&[\s\S]+?collabDocState[\s\S]+?\.needsRebootstrap\s*\)/,
    )
    // Effect's gate at the top:
    expect(SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*\n\s*if\s*\(!multiplayerDocId\)\s*return/,
    )
  })

  it("overlay copy names what's happening + why (no panic)", () => {
    // Different message than the frozen banner: this is INFO,
    // not an alert. Tells the user WHAT (updating) + WHY
    // (changed elsewhere) + WHAT'S HAPPENING (reconnecting).
    // No "you lost work" because case B means PM had no
    // unprojected edits.
    expect(SRC).toMatch(/Updating to latest content/i)
    expect(SRC).toMatch(/changed elsewhere|while you were idle/i)
    expect(SRC).toMatch(/Reconnecting/i)
    // Should NOT mention "unsaved" — that's the frozen banner's job
    const overlayText = SRC.split('collab-rebootstrap-overlay')[1]?.split('collab-frozen-banner')[0] ?? ''
    expect(overlayText.toLowerCase()).not.toContain('unsaved')
  })

  it('frozen banner + rebootstrap overlay are MUTUALLY EXCLUSIVE conditions', () => {
    // Order matters: rebootstrap overlay checks needsRebootstrap
    // FIRST, frozen banner checks frozen SECOND. Server invariant
    // (3.9.5 fix #4) ensures frozen dominates if both flags ever
    // simultaneously true — the rebootstrap path on server wouldn't
    // clear frozen, so client's frozen banner would still show
    // after the rebootstrap-overlay-induced reload. UI ordering
    // here matches that intent: rebootstrap overlay handles the
    // gentler case B; frozen banner handles the hard case A.
    const rebootstrapIdx = SRC.indexOf('collab-rebootstrap-overlay')
    const frozenIdx = SRC.indexOf('collab-frozen-banner')
    expect(rebootstrapIdx).toBeGreaterThan(-1)
    expect(frozenIdx).toBeGreaterThan(-1)
    expect(rebootstrapIdx).toBeLessThan(frozenIdx)
  })

  it('frozen dominates needsRebootstrap on client too (3.8.1.3 — prevents reload loop)', () => {
    // Edge case: server can theoretically end up with BOTH flags
    // simultaneously (case B fires → sets needsRebootstrap; later
    // a freeze branch fires for the SAME doc). Server invariant
    // from 3.9.5 fix #4 prevents bootstrap from clearing
    // needsRebootstrap when frozen=true. Without the client-side
    // frozen-dominates check, the rebootstrap overlay would fire,
    // trigger reload, new mount sees both flags still true,
    // rebootstrap overlay fires again, infinite loop.
    //
    // Fix: rebootstrap overlay condition includes !frozen; effect
    // also early-returns if frozen=true.
    expect(SRC).toMatch(/!collabDocState\.frozen[\s\S]+?collabDocState\.needsRebootstrap/)
    expect(SRC).toMatch(
      /if\s*\(collabDocState\.frozen\)\s*return[\s\S]+?frozen dominates/i,
    )
  })
})
