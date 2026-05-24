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

  it('calls useCollabSync inside CrepeEditor gated on bootstrap success (3.8.1.7)', () => {
    // The hook is invoked with the right gating shape; passing
    // enabled:false (when the prop is unset) means useCollabSync
    // short-circuits the bootstrap + returns no plugins.
    //
    // 3.8.1.7 [P1] #1: enabled now ALSO requires bootstrap
    // mutation phase==='ok'. Without that, useCollabSync fetches
    // snapshot too early (sees null/v0), builds plugins at
    // stale startVersion, races the server's bootstrap-mutation-
    // created v=1 snapshot.
    expect(SRC).toContain('useCollabSync({')
    expect(SRC).toMatch(
      /enabled:\s*!!multiplayerDocId\s*&&\s*bootstrapState\.phase === 'ok'/,
    )
    expect(SRC).toMatch(/docId:\s*multiplayerDocId \?\? null/)
  })

  it('captures plugins in a ref but DOES NOT install at closure time (3.8.1.4)', () => {
    // The ref is still populated each render (the late-install
    // effect reads it). The closure-time install was REMOVED in
    // 3.8.1.4: useCollabBootstrapMutation needs PM JSON extracted
    // from Crepe AFTER mount, so the bootstrap mutation cannot
    // complete before the useEditor closure runs. The previous
    // closure-time install path bypassed the new mutation gate
    // and would race-install collab plugins before the collabDocs
    // row existed. Removing it is the safe serialization.
    expect(SRC).toContain('collabPluginsRef.current = collabSync.plugins')
    // The closure must NOT iterate the ref to install plugins.
    expect(SRC).not.toMatch(/for \(const p of collabPluginsRef\.current\)/)
    // Comment explains the removal — pin so a refactor doesn't
    // accidentally restore the broken pattern.
    expect(SRC).toMatch(/DO NOT install collab plugins at closure[\s\S]+?time/i)
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
    // Each gating callsite (one per component layer) passes null
    // when multiplayer is off, so the Convex 'skip' idiom keeps
    // the call free of network cost. Hook source pins are in
    // collabSync.test.ts.
    const useCollabSyncCount = (SRC.match(/useCollabSync\(/g) ?? []).length
    expect(useCollabSyncCount).toBe(1)
    // useRemoteVersion is called twice as of 3.8.1.5: once inside
    // CrepeEditor for the remote-pull loop, once at the outer
    // AtomEditor level as the heartbeat that lets the rebootstrap
    // effect re-run after our pending steps ack (codex 7th-pass
    // [P1] #2 client mirror). Convex's useQuery dedupes identical
    // subscriptions internally — no extra network cost.
    const useRemoteVersionCount = (SRC.match(/useRemoteVersion\(/g) ?? [])
      .length
    expect(useRemoteVersionCount).toBe(2)
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

// M1 step 3.8.1.4 — wire the bootstrap mutation. Codex 7th-pass
// caught that the prior client tier shipped UI for the frozen +
// needsRebootstrap signals but NEVER called the mutation that
// actually creates the collabDocs row + clears those flags. These
// tests pin the wiring so a future refactor can't quietly remove
// it again.
describe('AtomEditor — bootstrap mutation wiring (3.8.1.4)', () => {
  it('imports useCollabBootstrapMutation from collab-sync', () => {
    expect(SRC).toMatch(
      /useCollabBootstrapMutation[\s\S]*?from '@\/lib\/collab-sync'/,
    )
  })

  it('extracts PM JSON from the mounted Crepe in an after-mount effect', () => {
    // Same pattern as captureSchemaFromEditor: useEffect runs
    // after every render, reads editorViewCtx, captures PM JSON
    // via doc.toJSON(). Gated on multiplayerDocId + pmJsonStr
    // not yet set, so it does zero work for single-user mounts
    // and is idempotent on subsequent re-renders.
    expect(SRC).toMatch(/capture PM JSON from the freshly-mounted/i)
    expect(SRC).toMatch(/view\.state\.doc\.toJSON\(\)/)
    expect(SRC).toMatch(/setPmJsonStr\(JSON\.stringify\(/)
    // Short-circuit when already captured.
    expect(SRC).toMatch(/if \(pmJsonStr !== null\) return/)
  })

  it('calls useCollabBootstrapMutation with body=defaultValue + the captured pmJsonStr', () => {
    expect(SRC).toContain('useCollabBootstrapMutation({')
    expect(SRC).toMatch(/body:\s*multiplayerDocId\s*\?\s*defaultValue\s*:\s*null/)
    expect(SRC).toMatch(/pmJsonStr,/)
    expect(SRC).toMatch(/enabled:\s*!!multiplayerDocId/)
  })

  it('late-install effect gates on bootstrapState.phase === "ok"', () => {
    // The whole point of 3.8.1.4: don't let collab plugins
    // install until the collabDocs row exists. Without this
    // gate, submitSteps would fire deltas the projection writer
    // can't bind to.
    expect(SRC).toMatch(
      /if \(bootstrapState\.phase !== 'ok'\) return/,
    )
    // Phase is in the dep array so the install fires when it
    // transitions ok.
    expect(SRC).toMatch(
      /\[multiplayerDocId, collabSync\.plugins, bootstrapState\.phase\]/,
    )
  })

  it('renders BootstrapErrorOverlay when phase === "error"', () => {
    expect(SRC).toMatch(
      /if \(multiplayerDocId && bootstrapState\.phase === 'error'\)/,
    )
    expect(SRC).toContain('<BootstrapErrorOverlay')
    expect(SRC).toMatch(/reason=\{bootstrapState\.reason\}/)
  })

  it('renders null on phase === "frozen" (outer banner takes over)', () => {
    // 'frozen' should NOT render the inner editor. The outer
    // AtomEditor's frozen banner (driven by useCollabDocState)
    // will mount within one Convex tick. Inner returns null to
    // avoid a brief flash of the editor before the banner takes
    // over.
    expect(SRC).toMatch(
      /if \(multiplayerDocId && bootstrapState\.phase === 'frozen'\)[\s\S]{0,400}?return null/,
    )
  })

  it('BootstrapErrorOverlay auto-reloads after 4s + has reload button', () => {
    expect(SRC).toContain('function BootstrapErrorOverlay')
    expect(SRC).toMatch(/setTimeout\([\s\S]*?window\.location\.reload\(\)[\s\S]*?,\s*4000\)/)
    expect(SRC).toMatch(/Reload now/)
    expect(SRC).toContain('data-testid="collab-bootstrap-error"')
    expect(SRC).toContain('role="alert"')
  })

  it('reason-specific copy covers every non-frozen failure reason', () => {
    // body-changed | invalid-pm-json | atom-not-found | pm-body-mismatch | network
    // 'frozen' is handled separately (returns null; outer banner).
    expect(SRC).toMatch(/case 'body-changed'/)
    expect(SRC).toMatch(/case 'atom-not-found'/)
    expect(SRC).toMatch(/case 'pm-body-mismatch'/)
    expect(SRC).toMatch(/case 'invalid-pm-json'/)
    expect(SRC).toMatch(/case 'network'/)
  })

  it('closure-time install of collab plugins is REMOVED (3.8.1.4)', () => {
    // The closure runs synchronously at mount, before the
    // bootstrap mutation could possibly complete (the mutation
    // needs PM JSON extracted FROM the just-mounted editor).
    // Installing at closure time would bypass the new mutation
    // gate. Removed = safe.
    expect(SRC).not.toMatch(/for \(const p of collabPluginsRef\.current\) extra\.push/)
  })
})

// M1 step 3.8.1.7 — Crepe read-only until collab is ready.
describe('AtomEditor — read-only-until-collab-ready gate (3.8.1.7)', () => {
  it('effect calls crepe.setReadonly based on collabReady state', () => {
    // [P1] #2: before this effect, the editor was writable from
    // mount → user could type during the ~500ms bootstrap window,
    // edits weren't tracked by prosemirror-collab, first
    // remote-pull rebased past them = silent data loss.
    expect(SRC).toMatch(
      /codex 8th-pass \[P1\] #2 GATE/,
    )
    expect(SRC).toMatch(/crepe\.setReadonly\(/)
    // collabReady combines bootstrap success + plugins arrival.
    expect(SRC).toMatch(/bootstrapState\.phase === 'ok'\s*&&\s*collabSync\.plugins !== null/)
  })

  it('respects the readOnly prop (shared-atom view-only mode wins)', () => {
    // The original readOnly prop must take precedence — a
    // view-only shared atom stays read-only even after collab
    // is "ready".
    expect(SRC).toMatch(/if \(readOnly\) \{[\s\S]+?setReadonly\(true\)[\s\S]+?return[\s\S]+?\}/)
  })

  it('single-user mode (no multiplayerDocId) leaves Crepe writable', () => {
    // No gate on single-user mounts — same as pre-3.8.1.7.
    expect(SRC).toMatch(/if \(!multiplayerDocId\) \{[\s\S]+?setReadonly\(false\)[\s\S]+?return[\s\S]+?\}/)
  })

  it('effect deps include all four inputs to the readonly decision', () => {
    expect(SRC).toMatch(
      /\[readOnly, multiplayerDocId, bootstrapState\.phase, collabSync\.plugins\]/,
    )
  })
})

// M1 step 3.8.1.5 — pending-steps gate on auto-reload.
describe('AtomEditor — auto-reload pending-steps gate (3.8.1.5)', () => {
  it('imports sendableSteps from prosemirror-collab', () => {
    expect(SRC).toMatch(/import \{ sendableSteps \} from 'prosemirror-collab'/)
  })

  it('rebootstrap effect peeks inside collab plugin state via crepeRef', () => {
    // Without this peek, the auto-reload would nuke any
    // unsubmitted local edits (which live in the prosemirror-collab
    // plugin's unconfirmed buffer). The check goes through
    // editorViewCtx (same pattern as captureSchemaFromEditor and
    // the bootstrap PM JSON extraction).
    expect(SRC).toMatch(/PENDING-STEPS GATE[\s\S]+?codex 7th-pass \[P1\] #2/i)
    // Effect body queries sendableSteps via the editor view.
    const reloadEffect = SRC.split('REBOOTSTRAP AUTO-RELOAD')[1]?.split('// 3.8.1.5 — remoteVersion')[0] ?? ''
    expect(reloadEffect).toMatch(/sendableSteps\(view\.state\)/)
    // Pending → return without scheduling.
    expect(reloadEffect).toMatch(/if \(pending\) \{[\s\S]+?return/)
  })

  it('remoteVersion is in the rebootstrap effect deps (heartbeat for re-run)', () => {
    // Without remoteVersion in deps, the effect would only re-run
    // on collabDocState change. A user with pending steps would
    // never get the auto-reload to fire because nothing else
    // triggers re-evaluation. Adding remoteVersion as the
    // heartbeat: when our pending steps ack on the server, the
    // version bumps, our useRemoteVersion fires, the effect
    // re-runs with sendableSteps now empty → reload proceeds.
    expect(SRC).toMatch(/remoteVersionForReload/)
    expect(SRC).toMatch(/const remoteVersionForReload = useRemoteVersion\(/)
    // Dep array contains it.
    expect(SRC).toMatch(
      /\[[\s\S]*?multiplayerDocId,[\s\S]*?collabDocState,[\s\S]*?remoteVersionForReload,?[\s\S]*?\]/,
    )
  })

  it('mount-in-flight crepe (action throws) defers gracefully', () => {
    // Crepe.create() is async; editor.action can throw if called
    // before create resolves. The gate's try/catch deferss to the
    // next render's effect rather than treating the throw as
    // "no pending steps" (which would proceed with reload).
    const reloadEffect = SRC.split('REBOOTSTRAP AUTO-RELOAD')[1]?.split('Auto-reload after a brief')[0] ?? ''
    expect(reloadEffect).toMatch(/} catch \{[\s\S]+?return/)
    expect(reloadEffect).toMatch(/Editor mid-mount/i)
  })
})
