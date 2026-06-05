// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomEditor, type AtomEditorHandle } from './AtomEditor'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const tiptapState = vi.hoisted(() => ({
  editors: [] as Array<{
    isEditable: boolean
    setEditable: ReturnType<typeof vi.fn>
    commands: { focus: ReturnType<typeof vi.fn> }
    view: {
      state: { tr: { setMeta: ReturnType<typeof vi.fn> } }
      dispatch: ReturnType<typeof vi.fn>
    }
    getMarkdown: ReturnType<typeof vi.fn>
    extensions: unknown[]
  }>,
}))

const hocuspocusState = vi.hoisted(() => ({
  resolvedUrl: 'ws://sync.test',
  capabilities: { atomBootstrap: true } as
    | { atomBootstrap: boolean }
    | Promise<{ atomBootstrap: boolean }>,
  documentState: { exists: true },
  providers: [] as Array<{
    url: string
    documentName: string
    ydoc: unknown
    token: unknown
    awareness?: unknown
    onAuthenticated?: () => void
    onAuthenticationFailed?: (event: { reason: string }) => void
    onSynced?: (event: { state: boolean }) => void
    onStatus?: (event: { status: string }) => void
  }>,
  awarenesses: [] as Array<{
    ydoc: unknown
    options: {
      publish: boolean
      user: { id: string; name?: string | null; color: string }
    }
    awareness: { marker: string }
  }>,
  destroyProvider: vi.fn(),
  stopRefresh: vi.fn(),
}))

const caretState = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
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

vi.mock('../lib/active-workspace', () => ({
  useActiveWorkspaceId: () => undefined,
}))

vi.mock('@tiptap/react', () => ({
  useEditor: (options: { editable?: boolean; extensions?: unknown[] }) => {
    const tr = { setMeta: vi.fn() }
    tr.setMeta.mockReturnValue(tr)
    const editor = {
      isEditable: options.editable !== false,
      setEditable: vi.fn((editable: boolean) => {
        editor.isEditable = editable
      }),
      commands: { focus: vi.fn() },
      view: {
        state: { tr },
        dispatch: vi.fn(),
      },
      getMarkdown: vi.fn(() => ''),
      extensions: options.extensions ?? [],
    }
    editor.setEditable(options.editable !== false)
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

vi.mock('@tiptap/extension-collaboration', () => ({
  Collaboration: {
    configure: (config: unknown) => ({ name: 'collaboration', config }),
  },
  isChangeOrigin: () => false,
}))

vi.mock('@tiptap/extension-collaboration-caret', () => ({
  CollaborationCaret: {
    configure: (config: Record<string, unknown>) => {
      caretState.configs.push(config)
      return { name: 'collaboration-caret', config }
    },
  },
}))

vi.mock('yjs', () => ({
  Doc: class {
    destroy = vi.fn()
  },
  applyUpdate: vi.fn(),
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
  NodeSelection: {
    create: () => ({}),
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
  fetchHocuspocusCapabilities: vi.fn(() =>
    Promise.resolve(hocuspocusState.capabilities),
  ),
  fetchHocuspocusDocumentState: vi.fn(async () => hocuspocusState.documentState),
  createDohcHocuspocusProvider: vi.fn((options) => {
    hocuspocusState.providers.push(options)
    return {
      destroy: hocuspocusState.destroyProvider,
      sendToken: vi.fn(),
    }
  }),
  createDohcAwareness: vi.fn((ydoc, options) => {
    const awareness = { marker: `awareness-${hocuspocusState.awarenesses.length}` }
    hocuspocusState.awarenesses.push({ ydoc, options, awareness })
    return awareness
  }),
  startHocuspocusTokenRefresh: vi.fn(() => hocuspocusState.stopRefresh),
}))

const ydocSeedState = vi.hoisted(() => ({
  markdownInputs: [] as string[],
  appliedUpdates: [] as Uint8Array[],
}))

vi.mock('../editor-v2/import-export', () => ({
  markdownToYDoc: vi.fn((markdown: string) => {
    ydocSeedState.markdownInputs.push(markdown)
    return { __dohcSeedMarkdown: markdown, destroy: vi.fn() }
  }),
  encodeDohcYDocUpdate: vi.fn((doc: { __dohcSeedMarkdown: string }) => {
    const update = new TextEncoder().encode(doc.__dohcSeedMarkdown)
    ydocSeedState.appliedUpdates.push(update)
    return update
  }),
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
    hocuspocusState.documentState = { exists: true }
    hocuspocusState.providers = []
    hocuspocusState.awarenesses = []
    caretState.configs = []
    indexeddbState.instances = []
    ydocSeedState.markdownInputs = []
    ydocSeedState.appliedUpdates = []
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const node of Array.from(document.body.children)) node.remove()
  })

  it('mounts collaboration-required atoms as read-only when sync is unavailable', async () => {
    hocuspocusState.resolvedUrl = null as unknown as string

    const { container } = await mountAtomEditor()

    expect(container.textContent).toContain('Sync unavailable')
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)
    expect(hocuspocusState.providers).toHaveLength(0)
  })

  it('client-bootstraps from the current markdown when local Hocuspocus has no Convex bootstrap and no document state yet', async () => {
    hocuspocusState.capabilities = { atomBootstrap: false }
    hocuspocusState.documentState = { exists: false }

    await mountAtomEditor({ value: '# Local body' })
    await fireIndexeddbSynced(0)

    expect(ydocSeedState.markdownInputs).toEqual(['# Local body'])
    expect(hocuspocusState.providers.length).toBeGreaterThanOrEqual(1)
    await act(async () => {
      hocuspocusState.providers[0]?.onSynced?.({ state: true })
    })
    await flushReact()
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(true)
    expect(containerStatusText()).not.toContain('Sync unavailable')
  })

  it('waits for local IndexedDB hydration and first remote sync before enabling edits', async () => {
    const { container } = await mountAtomEditor()

    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)
    expect(container.querySelector('[data-testid="editor-content"]')).toBeNull()
    expect(indexeddbState.instances).toHaveLength(1)
    await fireIndexeddbSynced(0)

    expect(hocuspocusState.providers.length).toBeGreaterThanOrEqual(1)
    expect(hocuspocusState.providers[0]?.documentName).toBe(documentName())
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)
    expect(container.querySelector('[data-testid="editor-content"]')).toBeNull()

    await act(async () => {
      hocuspocusState.providers[0]?.onSynced?.({ state: true })
    })
    await flushReact()

    expect(localStorage.getItem(`dohc:yjs-cache:${documentName()}`)).toBe('1')
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(true)
    expect(container.querySelector('[data-testid="editor-content"]')).not.toBeNull()
    expect(containerStatusText()).not.toContain('Syncing')
  })

  it('continues to remote sync when IndexedDB hydration never responds', async () => {
    vi.useFakeTimers()

    await mountAtomEditor()

    expect(indexeddbState.instances).toHaveLength(1)
    expect(hocuspocusState.providers).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(2500)
      await Promise.resolve()
    })
    await flushReact()

    expect(hocuspocusState.providers.length).toBeGreaterThanOrEqual(1)
    expect(hocuspocusState.providers[0]?.documentName).toBe(documentName())
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)
  })

  it('surfaces sync unavailable when Hocuspocus bootstrap never responds', async () => {
    vi.useFakeTimers()
    hocuspocusState.capabilities = new Promise(() => {})

    await mountAtomEditor()

    expect(containerStatusText()).toContain('Syncing')
    expect(hocuspocusState.providers).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })
    await flushReact()

    expect(containerStatusText()).toContain('Sync unavailable')
    expect(hocuspocusState.providers).toHaveLength(0)
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)
  })

  it('surfaces sync unavailable instead of staying on Syncing forever', async () => {
    vi.useFakeTimers()

    await mountAtomEditor()
    await fireIndexeddbSynced(0)

    expect(hocuspocusState.providers.length).toBeGreaterThanOrEqual(1)
    expect(containerStatusText()).toContain('Syncing')

    await act(async () => {
      vi.advanceTimersByTime(12000)
      await Promise.resolve()
    })
    await flushReact()

    expect(containerStatusText()).toContain('Sync unavailable')
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(false)

    await act(async () => {
      hocuspocusState.providers[0]?.onSynced?.({ state: true })
    })
    await flushReact()

    expect(containerStatusText()).not.toContain('Sync unavailable')
    expect(tiptapState.editors.at(-1)?.setEditable).toHaveBeenLastCalledWith(true)
  })

  it('does not allow imperative code-block inserts while the collaborative editor is read-only', async () => {
    const ref = React.createRef<AtomEditorHandle>()

    await mountAtomEditor({ ref })
    tiptapState.editors.at(-1)?.view.dispatch.mockClear()
    await act(async () => {
      ref.current?.insertCodeBlock('text', 'should not write yet')
      ref.current?.replaceCodeBlockAt(0, 'should not write yet', 'text')
    })

    expect(tiptapState.editors.at(-1)?.view.dispatch).not.toHaveBeenCalled()
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
    expect(containerStatusText()).not.toContain('Syncing')
    expect(containerStatusText()).not.toContain('Sync unavailable')
  })

  it('wires safe Yjs awareness and collaboration carets for editable collaborators', async () => {
    await mountAtomEditor()
    await fireIndexeddbSynced(0)

    expect(hocuspocusState.awarenesses).toHaveLength(1)
    expect(hocuspocusState.awarenesses[0]?.options).toEqual({
      publish: true,
      user: {
        id: 'workspace_1',
        name: 'You',
        color: '#4f46e5',
      },
    })
    expect(hocuspocusState.providers[0]?.awareness).toBe(
      hocuspocusState.awarenesses[0]?.awareness,
    )
    expect(caretState.configs.at(-1)).toMatchObject({
      provider: { awareness: hocuspocusState.awarenesses[0]?.awareness },
      user: {
        id: 'workspace_1',
        name: 'You',
        color: '#4f46e5',
      },
    })
    expect(
      tiptapState.editors
        .at(-1)
        ?.extensions.some(
          (extension) =>
            (extension as { name?: string }).name === 'collaboration-caret',
        ),
    ).toBe(true)
  })

  it('configures Tiptap with Notion-style empty block affordances', async () => {
    await mountAtomEditor({ collab: undefined })

    const extensions = tiptapState.editors.at(-1)?.extensions ?? []
    const placeholder = extensions.find(
      (extension) => (extension as { name?: string }).name === 'placeholder',
    ) as {
      config?: {
        includeChildren?: boolean
        showOnlyCurrent?: boolean
        placeholder?: (args: { node: { type: { name: string } } }) => string
      }
    }
    const trailingNode = extensions.find(
      (extension) => (extension as { name?: string }).name === 'trailing-node',
    ) as { config?: { node?: string; notAfter?: string[] } }

    expect(placeholder.config).toMatchObject({
      includeChildren: true,
      showOnlyCurrent: false,
    })
    expect(
      placeholder.config?.placeholder?.({
        node: { type: { name: 'paragraph' } },
      }),
    ).toBe("Type '/' for commands")
    expect(
      placeholder.config?.placeholder?.({
        node: { type: { name: 'tableCell' } },
      }),
    ).toBe('')
    expect(trailingNode.config).toEqual({
      node: 'paragraph',
      notAfter: ['paragraph'],
    })
  })

  it('does not mount client-only trailing nodes in collaborative editors', async () => {
    await mountAtomEditor()

    const extensions = tiptapState.editors.at(-1)?.extensions ?? []
    expect(
      extensions.some(
        (extension) => (extension as { name?: string }).name === 'trailing-node',
      ),
    ).toBe(false)
    expect(
      (extensions.find(
        (extension) => (extension as { name?: string }).name === 'starter-kit',
      ) as { config?: { trailingNode?: unknown } })?.config,
    ).toMatchObject({ trailingNode: false })
  })

  it('keeps StarterKit before custom block nodes so Enter creates paragraphs, not query blocks', async () => {
    await mountAtomEditor({ collab: undefined })

    const names = (tiptapState.editors.at(-1)?.extensions ?? []).map(
      (extension) => (extension as { name?: string }).name,
    )
    expect(names.indexOf('starter-kit')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('queryBlock')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('starter-kit')).toBeLessThan(names.indexOf('queryBlock'))
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
