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
    // useCollabSync with enabled:false MUST early-return without
    // calling Convex. The hook's source already pins this
    // (collabSync.test.ts), but pin the AtomEditor side too:
    // the hook call is the ONLY new Convex surface added for
    // multiplayer in this file (modulo useRemoteVersion which is
    // also gated by the docId pass-through).
    const useCollabSyncCount = (SRC.match(/useCollabSync\(/g) ?? []).length
    expect(useCollabSyncCount).toBe(1)
    const useRemoteVersionCount = (SRC.match(/useRemoteVersion\(/g) ?? [])
      .length
    expect(useRemoteVersionCount).toBe(1)
  })
})
