/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// M1 step 2 (multiplayer-and-h-followups §8) — structural guards on
// the Milkdown collab adapter. The lib file is dormant until
// AtomEditor wires it in (next sub-commit), so end-to-end testing
// is out of scope here. What matters now is that the building
// blocks compose correctly:
//   - the public hook + the two plugin factories are exported
//   - the bootstrap closes over the four sync API endpoints
//   - the plugin set is stable per (docId, schema) so a re-render
//     doesn't tear down + remount the editor's plugin state
//   - the package uses Milkdown's prose re-exports (not the bare
//     prosemirror-* packages) to avoid duplicate-module hazards
//
// These are EXACTLY the wiring bugs you can't catch without running
// the editor, so a structural pin keeps a refactor from silently
// breaking the integration.

const SRC = readFileSync(resolve(__dirname, '../lib/collab-sync.ts'), 'utf8')

describe('collab-sync — public API surface', () => {
  it('exports useCollabSync + the two plugin factories + applyRemoteSteps', () => {
    expect(SRC).toMatch(/export function useCollabSync/)
    expect(SRC).toMatch(/export function makeCollabPlugin/)
    expect(SRC).toMatch(/export function makeSyncBridgePlugin/)
    expect(SRC).toMatch(/export function applyRemoteSteps/)
    expect(SRC).toMatch(/export async function bootstrapDocFromSync/)
    expect(SRC).toMatch(/export function useRemoteVersion/)
    expect(SRC).toMatch(/export \{ getVersion \} from 'prosemirror-collab'/)
  })

  it('imports prose types from @milkdown/kit/prose/* (not prosemirror-*)', () => {
    // Milkdown's docs explicitly warn against direct prosemirror-*
    // imports: it can create duplicate module instances and break
    // plugin matching. The re-exports under @milkdown/kit/prose/*
    // share Milkdown's own instances. This pin prevents a future
    // copy-paste from sneaking in a bad import.
    expect(SRC).toMatch(/from '@milkdown\/kit\/prose\/state'/)
    expect(SRC).toMatch(/from '@milkdown\/kit\/prose\/transform'/)
    expect(SRC).toMatch(/from '@milkdown\/kit\/prose\/model'/)
    expect(SRC).not.toMatch(/from 'prosemirror-state'/)
    expect(SRC).not.toMatch(/from 'prosemirror-transform'/)
    expect(SRC).not.toMatch(/from 'prosemirror-model'/)
  })

  it('uses all four sync API endpoints (getSnapshot, getSteps, submitSteps, latestVersion)', () => {
    expect(SRC).toContain('api.prosemirror.getSnapshot')
    expect(SRC).toContain('api.prosemirror.getSteps')
    expect(SRC).toContain('api.prosemirror.submitSteps')
    expect(SRC).toContain('api.prosemirror.latestVersion')
  })
})

describe('collab-sync — orchestration invariants', () => {
  it('clientId is crypto.randomUUID (collisions would mis-attribute steps)', () => {
    expect(SRC).toContain('crypto.randomUUID()')
  })

  it('plugin set is stable per docId (ref-cached); resets only on docId change', () => {
    // The ref-cache prevents the plugin from being re-instantiated
    // on every render — losing the prosemirror-collab version
    // state would force a re-rebase of every pending step.
    expect(SRC).toContain('pluginsRef.current?.docId !== docId')
  })

  it('inFlight + pendingNotify coalesce concurrent submit calls', () => {
    // Without coalescing, a flurry of editor updates would queue
    // overlapping submitSteps calls; the second submit would race
    // with the first's "synced" result and the version state
    // diverges. The bridge plugin must serialize.
    expect(SRC).toContain('let inFlight = false')
    expect(SRC).toContain('let pendingNotify = false')
    expect(SRC).toMatch(/queueMicrotask\(\(\) => void trySubmit\(\)\)/)
  })

  it('useRemoteVersion collapses null → undefined for clean diff logic', () => {
    expect(SRC).toMatch(/v == null \? undefined : v/)
  })

  it('bootstrap honors the `enabled` flag (off-switch for AtomEditor opt-in)', () => {
    expect(SRC).toMatch(/if \(!enabled \|\| !docId \|\| !schema\)/)
    // Plugins null when disabled so the editor mounts in
    // single-user mode (no collab plugin attached).
    expect(SRC).toContain('if (enabled && docId && bootstrap.ready) {')
  })
})

describe('collab-sync — failure modes', () => {
  it('corrupt snapshot ⇒ falls through to empty-doc bootstrap (no throw)', () => {
    expect(SRC).toMatch(/Corrupt snapshot/i)
    expect(SRC).toMatch(/return \{ doc: null, version: 0 \}/)
  })

  it('bad replay step ⇒ surfaces version=-1 so the caller can show an error', () => {
    expect(SRC).toMatch(/A bad step is a contract violation/)
    expect(SRC).toMatch(/version === -1/)
  })

  it('submit-throw ⇒ leaves inFlight=false so the next edit retries (no data loss)', () => {
    expect(SRC).toMatch(/A throw is a real outage/)
    // The retry path is implicit — `inFlight = false` in the
    // finally block + the next update() call drives trySubmit().
    expect(SRC).toMatch(/inFlight = false/)
  })
})
