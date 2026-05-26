import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

const providerState = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
}))

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    constructor(config: Record<string, unknown>) {
      providerState.configs.push(config)
    }
  },
}))

import {
  createDohcAwareness,
  createDohcHocuspocusProvider,
} from './hocuspocusProvider'

describe('hocuspocus provider awareness adapter', () => {
  it('publishes only the safe user awareness fields for editable collaborators', () => {
    const ydoc = new Y.Doc()
    const awareness = createDohcAwareness(ydoc, {
      publish: true,
      user: {
        id: 'workspace_1',
        name: 'Ice',
        color: '#4f46e5',
        email: 'private@example.test',
      },
    })

    expect(awareness.getLocalState()).toEqual({
      user: {
        id: 'workspace_1',
        name: 'Ice',
        color: '#4f46e5',
      },
    })
  })

  it('keeps read-only collaborators from publishing local cursor state', () => {
    const ydoc = new Y.Doc()
    const awareness = createDohcAwareness(ydoc, {
      publish: false,
      user: {
        id: 'workspace_1',
        name: 'Ice',
        color: '#4f46e5',
      },
    })

    expect(awareness.getLocalState()).toBeNull()
  })

  it('passes the configured Awareness instance into HocuspocusProvider', () => {
    const ydoc = new Y.Doc()
    const awareness = createDohcAwareness(ydoc, {
      publish: true,
      user: { id: 'workspace_1', name: 'Ice', color: '#4f46e5' },
    })

    createDohcHocuspocusProvider({
      url: 'ws://sync.test',
      documentName: 'workspace/workspace_1/atom/atom_1',
      ydoc,
      token: 'jwt',
      awareness,
    })

    expect(providerState.configs.at(-1)).toMatchObject({
      url: 'ws://sync.test',
      name: 'workspace/workspace_1/atom/atom_1',
      awareness,
    })
  })
})
