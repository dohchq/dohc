// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomEditor, type AtomEditorHandle } from './AtomEditor'
import { encodeAsciiSketchContent } from '../lib/asciiSketchMetadata'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

vi.mock('convex/react', () => ({
  useAction: () => async () => 'collab.jwt',
  useQuery: () => undefined,
}))

vi.mock('../lib/active-workspace', () => ({
  useActiveWorkspaceId: () => undefined,
}))

vi.mock('@tiptap/extensions/placeholder', () => ({
  Placeholder: {
    configure: (config: unknown) => ({ name: 'placeholder', config }),
  },
}))

vi.mock('@tiptap/extensions/trailing-node', () => ({
  TrailingNode: {
    configure: (config: unknown) => ({ name: 'trailing-node', config }),
  },
}))

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    whenSynced = Promise.resolve()
    private listeners: Array<() => void> = []

    constructor() {
      queueMicrotask(() => {
        for (const listener of this.listeners) listener()
      })
    }

    on(event: string, listener: () => void) {
      if (event === 'synced') this.listeners.push(listener)
    }

    destroy() {}
  },
}))

vi.mock('../editor-v2/indexeddbState', () => ({
  hasIndexeddbYDocState: vi.fn(async () => false),
  markIndexeddbYDocState: vi.fn(),
}))

vi.mock('../editor-v2/hocuspocusProvider', async () => {
  const { Awareness } =
    await vi.importActual<typeof import('y-protocols/awareness')>(
      'y-protocols/awareness',
    )

  return {
    encodeDohcHocuspocusDocumentName: ({
      workspaceId,
      atomId,
    }: {
      workspaceId: string
      atomId: string
    }) => `workspace/${workspaceId}/atom/${atomId}`,
    resolveHocuspocusUrl: () => 'ws://sync.test',
    fetchHocuspocusCapabilities: vi.fn(async () => ({ atomBootstrap: false })),
    fetchHocuspocusDocumentState: vi.fn(async () => ({ exists: false })),
    createDohcAwareness: vi.fn((ydoc, options) => {
      const awareness = new Awareness(ydoc)
      if (options.publish) awareness.setLocalStateField('user', options.user)
      return awareness
    }),
    createDohcHocuspocusProvider: vi.fn((options) => {
      queueMicrotask(() => options.onSynced?.({ state: true }))
      return { destroy: vi.fn(), sendToken: vi.fn() }
    }),
    startHocuspocusTokenRefresh: vi.fn(() => vi.fn()),
  }
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('AtomEditor real Tiptap mount', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('mounts editable markdown without throwing', () => {
    expect(() => {
      act(() => {
        root.render(
          React.createElement(AtomEditor, {
            value: '# tiptap\n\nhello',
            onChange: () => {},
            knownFiles: [],
          }),
        )
      })
    }).not.toThrow()

    expect(container.textContent).toContain('tiptap')
  })

  it('mounts collaborative markdown without throwing', async () => {
    expect(() => {
      act(() => {
        root.render(
          React.createElement(AtomEditor, {
            value: '# tiptap\n\nhello',
            onChange: () => {},
            knownFiles: [],
            collab: { workspaceId: 'workspace_1', atomId: 'atom_1' },
          }),
        )
      })
    }).not.toThrow()

    await flush()

    expect(container.textContent).toContain('tiptap')
  })

  it('renders synced presence without a local-only collaborator avatar', async () => {
    act(() => {
      root.render(
        React.createElement(AtomEditor, {
          value: '# tiptap\n\nhello',
          onChange: () => {},
          knownFiles: [],
          collab: {
            workspaceId: 'workspace_1',
            atomId: 'atom_1',
            userId: 'user_1',
            userName: 'Ice',
          },
        }),
      )
    })

    await flush()

    expect(container.querySelector('.dohc-editor-presence')).not.toBeNull()
    expect(container.querySelector('.dohc-editor-presence')?.textContent).toContain(
      'Synced',
    )
    expect(container.querySelector('.dohc-collab-avatar')).toBeNull()
  })

  it('marks ascii sketch metadata so it can render as natural page content', () => {
    const sketch = encodeAsciiSketchContent('+---+\n|   |\n+---+', {
      shapes: [],
    })

    act(() => {
      root.render(
        React.createElement(AtomEditor, {
          value: `\`\`\`ascii\n${sketch}\n\`\`\``,
          onChange: () => {},
          knownFiles: [],
        }),
      )
    })

    expect(container.querySelector('.ascii-sketch-block')).not.toBeNull()
    expect(container.querySelector('.ascii-sketch-metadata-line')).not.toBeNull()
  })

  it('renders Notion-style block controls for page blocks', () => {
    act(() => {
      root.render(
        React.createElement(AtomEditor, {
          value: 'First block\n\nSecond block',
          onChange: () => {},
          knownFiles: [],
        }),
      )
    })

    const controls = container.querySelectorAll('.dohc-block-affordance')
    expect(controls.length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('.dohc-block-plus')).not.toBeNull()
    expect(container.querySelector('.dohc-block-handle')).not.toBeNull()
  })

  it('inserts a writable paragraph after a new ascii sketch block', async () => {
    const ref = React.createRef<AtomEditorHandle>()

    act(() => {
      root.render(
        React.createElement(AtomEditor, {
          ref,
          value: '',
          onChange: () => {},
          knownFiles: [],
        }),
      )
    })

    await flush()

    act(() => {
      ref.current?.insertCodeBlock('ascii', '+---+\n|   |\n+---+')
    })

    const sketch = container.querySelector('.ascii-sketch-block')
    expect(sketch).not.toBeNull()
    expect(sketch?.nextElementSibling?.tagName).toBe('P')
  })
})
