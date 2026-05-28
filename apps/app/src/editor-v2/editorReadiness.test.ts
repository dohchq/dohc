import { describe, expect, it } from 'vitest'
import { canEditDohcEditor } from './editorReadiness'

describe('editor readiness', () => {
  it('keeps plain markdown fallback editable', () => {
    expect(
      canEditDohcEditor({
        collaborationEnabled: false,
        localReady: false,
        syncError: null,
      }),
    ).toBe(true)
  })

  it('blocks fallback edits when a collaborative document is required but sync is unavailable', () => {
    expect(
      canEditDohcEditor({
        collaborationRequired: true,
        collaborationEnabled: false,
        localReady: true,
        syncError: null,
      }),
    ).toBe(false)
  })

  it('blocks collaborative edits before first remote sync when there is no local cache', () => {
    expect(
      canEditDohcEditor({
        collaborationEnabled: true,
        localReady: true,
        remoteReady: false,
        hasLocalCache: false,
        syncError: null,
      }),
    ).toBe(false)
  })

  it('allows collaborative edits from a verified local cache before remote reconnects', () => {
    expect(
      canEditDohcEditor({
        collaborationEnabled: true,
        localReady: true,
        remoteReady: false,
        hasLocalCache: true,
        syncError: null,
      }),
    ).toBe(true)
  })

  it('allows collaborative edits after remote sync completes', () => {
    expect(
      canEditDohcEditor({
        collaborationEnabled: true,
        localReady: true,
        remoteReady: true,
        syncError: null,
      }),
    ).toBe(true)
  })

  it('blocks collaborative edits until local persistence has loaded', () => {
    expect(
      canEditDohcEditor({
        collaborationEnabled: true,
        localReady: false,
        remoteReady: true,
        syncError: null,
      }),
    ).toBe(false)
  })

  it('blocks edits while the editor is deciding whether sync can safely bootstrap', () => {
    expect(
      canEditDohcEditor({
        collaborationEnabled: false,
        collaborationPending: true,
        localReady: true,
        syncError: null,
      }),
    ).toBe(false)
  })

  it('blocks edits for read-only views and explicit sync auth failures', () => {
    expect(
      canEditDohcEditor({
        readOnly: true,
        collaborationEnabled: true,
        localReady: true,
        remoteReady: true,
        syncError: null,
      }),
    ).toBe(false)
    expect(
      canEditDohcEditor({
        collaborationEnabled: true,
        localReady: true,
        remoteReady: true,
        syncError: 'bad token',
      }),
    ).toBe(false)
  })
})
