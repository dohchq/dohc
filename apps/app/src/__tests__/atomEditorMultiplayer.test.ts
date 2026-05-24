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
