// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomEditor } from './AtomEditor'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const tiptapState = vi.hoisted(() => ({
  editors: [] as Array<{
    setEditable: ReturnType<typeof vi.fn>
    commands: { focus: ReturnType<typeof vi.fn> }
    view: {
      state: { tr: { setMeta: ReturnType<typeof vi.fn> } }
      dispatch: ReturnType<typeof vi.fn>
    }
    getMarkdown: ReturnType<typeof vi.fn>
  }>,
}))

const hocuspocusState = vi.hoisted(() => ({
  resolvedUrl: 'ws://sync.test',
  capabilities: { atomBootstrap: true },
  providers: [] as Array<{
    url: string
    documentName: string
    ydoc: unknown
    token: unknown
    onAuthenticated?: () => void
    onAuthenticationFailed?: (event: { reason: string }) => void
    onSynced?: (event: { state: boolean }) => void
    onStatus?: (event: { status: string }) => void
  }>,
  destroyProvider: vi.fn(),
  stopRefresh: vi.fn(),
}))

const indexeddbState = vi.hoisted(() => ({
  instances: [] as Array<{
    name: string
    destroy: ReturnType<typeof vi.fn>
    fireSynced: () => void
    whenSynced: Promise<void>
  }>,
}))

vi.mock('convex/react', () => ({
  useAction: () => async () => 'collab.jwt',
  useQuery: () => undefined,
}))

vi.mock('@tiptap/react', () => ({
  useEditor: (options: { editable?: boolean }) => {
    const tr = { setMeta: vi.fn() }
    tr.setMeta.mockReturnValue(tr)
    const editor = {
      setEditable: vi.fn(),
      commands: { focus: vi.fn() },
      view: {
        state: { tr },
        dispatch: vi.fn(),
      },
      getMarkdown: vi.fn(() => ''),
    }
    editor.setEditable(options.editable)
    tiptapState.editors.push(editor)
    return editor
  },
  EditorContent: () => React.createElement('div', { 'data-testid': 'editor-content' }),
}))

vi.mock('@tiptap/core', () => ({
  Extension: {
    create: (config: unknown) => config,
  },
  Node: {
    create: (config: unknown) => config,
  },
}))

vi.mock('@tiptap/starter-kit', () => ({
  StarterKit: {
    configure: (config: unknown) => ({ name: 'starter-kit', config }),
  },
}))

vi.mock('@tiptap/extension-table', () => ({
  TableKit: { name: 'table-kit' },
}))

vi.mock('@tiptap/markdown', () => ({
  Markdown: {
    configure: (config: unknown) => ({ name: 'markdown', config }),
  },
}))

vi.mock('@tiptap/extension-collaboration', () => ({
  Collaboration: {
    configure: (config: unknown) => ({ name: 'collaboration', config }),
  },
  isChangeOrigin: () => false,
}))

vi.mock('@tiptap/pm/state', () => ({
  Plugin: class {
    constructor(public config: unknown) {}
  },
  PluginKey: class {
    constructor(public name: string) {}
    getState() {
      return undefined
    }
  },
  TextSelection: {
    near: () => ({}),
  },
}))

vi.mock('@tiptap/pm/view', () => ({
  Decoration: {
    node: () => ({}),
    widget: () => ({}),
    inline: () => ({}),
  },
  DecorationSet: {
    create: () => ({}),
  },
}))

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    name: string
    destroy = vi.fn()
    private syncedListeners: Array<() => void> = []
    whenSynced: Promise<void>

    constructor(name: string) {
      this.name = name
      this.whenSynced = new Promise<void>(() => {})
      indexeddbState.instances.push({
        name,
        destroy: this.destroy,
        fireSynced: () => {
          for (const listener of this.syncedListeners) listener()
        },
        whenSynced: this.whenSynced,
      })
    }

    on(event: string, listener: () => void) {
      if (event === 'synced') this.syncedListeners.push(listener)
    }
  },
}))

vi.mock('../editor-v2/hocuspocusProvider', () => ({
  encodeDohcHocuspocusDocumentName: ({
    workspaceId,
    atomId,
  }: {
    workspaceId: string
    atomId: string
  }) => `workspace/${workspaceId}/atom/${atomId}`,
  resolveHocuspocusUrl: () => hocuspocusState.resolvedUrl,
  fetchHocuspocusCapabilities: vi.fn(async () => hocuspocusState.capabilities),
  createDohcHocuspocusProvider: vi.fn((options) => {
    hocuspocusState.providers.push(options)
    return {
      destroy: hocuspocusState.destroyProvider,
      sendToken: vi.fn(),
    }
  }),
  startHocuspocusTokenRefresh: vi.fn(() => hocuspocusState.stopRefresh),
}))

function documentName(workspaceId = 'workspace_1', atomId = 'atom_1') {
  return `workspace/${workspaceId}/atom/${atomId}`
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function fireIndexeddbSynced(index: number) {
  await act(async () => {
    indexeddbState.instances[index]?.fireSynced()
  })
  await flushReact()
}

async function mountAtomEditor(
  props: Partial<React.ComponentProps<typeof AtomEditor>> = {},
): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      React.createElement(AtomEditor, {
        value: 'hello',
        onChange: vi.fn(),
        collab: { workspaceId: 'workspace_1', atomId: 'atom_1' },
        ...props,
      }),
    )
  })
  await flushReact()
  return { root, container }
}

describe('AtomEditor collaborative browser lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    localStorage.clear()
    tiptapState.editors = []
    hocuspocusState.resolvedUrl = 'ws://sync.test'
    hocuspocusState.capabilities = { atomBootstrap: true }
    hocuspocusState.providers = []
    indexeddbState.instances = []
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    })
  })

  afterEach(() => {
    for (const node of Array.from(document.body.children)) node.remove()
  })

  it('mounts collaboration-required atoms as read-only when sync is unavailable', async () => {
    hocuspocusState.resolvedUrl = null as unknown as string

    const { container } = await mountAtomEditor()

    expect(container.textContent).toContain('Sync unavailable')
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)
    expect(hocuspocusState.providers).toHaveLength(0)
  })

  it('waits for local IndexedDB hydration and first remote sync before enabling edits', async () => {
    await mountAtomEditor()

    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)
    expect(indexeddbState.instances).toHaveLength(1)
    await fireIndexeddbSynced(0)

    expect(hocuspocusState.providers.length).toBeGreaterThanOrEqual(1)
    expect(hocuspocusState.providers[0]?.documentName).toBe(documentName())
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)

    await act(async () => {
      hocuspocusState.providers[0]?.onSynced?.({ state: true })
    })
    await flushReact()

    expect(localStorage.getItem(`dohc:yjs-cache:${documentName()}`)).toBe('1')
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(true)
    expect(containerStatusText()).not.toContain('Syncing')
  })

  it('allows offline resume after local cache is verified even before remote sync returns', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {},
    })
    localStorage.setItem(`dohc:yjs-cache:${documentName()}`, '1')

    await mountAtomEditor()
    await fireIndexeddbSynced(0)

    expect(hocuspocusState.providers.length).toBeGreaterThanOrEqual(1)
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(true)
  })

  it('mounts two collaborative editors into the same Hocuspocus document room', async () => {
    const first = await mountAtomEditor()
    const second = await mountAtomEditor()
    await fireIndexeddbSynced(0)
    await fireIndexeddbSynced(1)

    expect(hocuspocusState.providers.length).toBeGreaterThanOrEqual(2)
    expect(new Set(hocuspocusState.providers.map((provider) => provider.documentName))).toEqual(
      new Set([documentName()]),
    )

    await act(async () => {
      first.root.unmount()
      second.root.unmount()
    })
    expect(hocuspocusState.stopRefresh).toHaveBeenCalled()
    expect(hocuspocusState.destroyProvider).toHaveBeenCalled()
  })
})

function containerStatusText(): string {
  return document.body.textContent ?? ''
}
