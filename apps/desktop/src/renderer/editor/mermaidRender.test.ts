// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor, Extension } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TextSelection } from '@tiptap/pm/state'
import { dohcMarkdownExtensions } from './extensions'
import {
  computeMermaidBlocks,
  isMermaidBlockCollapsed,
  makeMermaidPreviewPlugin,
  MermaidRenderScheduler,
  MERMAID_STARTER_SNIPPET,
  renderMermaidDiagram,
  type MermaidRenderFn,
  type MermaidRenderResult,
} from './mermaidRender'

// --- pure `computeMermaidBlocks` / `isMermaidBlockCollapsed` over a
// hand-built fake doc (same offline-testing pattern as
// codeHighlight.test.ts's fakeDoc) ---

type FakeBlockNode = {
  type: { name: string }
  attrs: Record<string, unknown>
  textContent: string
  nodeSize: number
}

function fakeDoc(blocks: Array<{ pos: number; language: string; text: string }>): {
  descendants: (cb: (node: FakeBlockNode, pos: number) => boolean | void) => void
} {
  return {
    descendants(cb) {
      for (const b of blocks) {
        cb(
          {
            type: { name: 'codeBlock' },
            attrs: { language: b.language },
            textContent: b.text,
            nodeSize: b.text.length + 2,
          },
          b.pos,
        )
      }
    },
  }
}

describe('computeMermaidBlocks', () => {
  it('finds codeBlocks whose language is mermaid', () => {
    const doc = fakeDoc([{ pos: 4, language: 'mermaid', text: 'graph TD;A-->B' }])
    const blocks = computeMermaidBlocks(doc)
    expect(blocks).toEqual([{ pos: 4, end: 4 + 'graph TD;A-->B'.length + 2, text: 'graph TD;A-->B' }])
  })

  it('ignores non-mermaid code blocks', () => {
    const doc = fakeDoc([
      { pos: 0, language: 'typescript', text: 'const x = 1;' },
      { pos: 20, language: '', text: 'plain' },
    ])
    expect(computeMermaidBlocks(doc)).toEqual([])
  })

  it('is case/whitespace tolerant on the language attr', () => {
    const doc = fakeDoc([{ pos: 0, language: '  Mermaid  ', text: 'graph TD;A' }])
    expect(computeMermaidBlocks(doc)).toHaveLength(1)
  })

  it('finds multiple mermaid blocks in doc order', () => {
    const doc = fakeDoc([
      { pos: 0, language: 'mermaid', text: 'graph TD;A' },
      { pos: 20, language: 'mermaid', text: 'graph TD;B' },
    ])
    expect(computeMermaidBlocks(doc).map((b) => b.pos)).toEqual([0, 20])
  })
})

describe('isMermaidBlockCollapsed', () => {
  const block = { pos: 10, end: 30 }

  it('is collapsed when the cursor is before the block', () => {
    expect(isMermaidBlockCollapsed(block, 5)).toBe(true)
  })

  it('is collapsed when the cursor is after the block', () => {
    expect(isMermaidBlockCollapsed(block, 35)).toBe(true)
  })

  it('is NOT collapsed anywhere inside the inclusive block range', () => {
    expect(isMermaidBlockCollapsed(block, 10)).toBe(false)
    expect(isMermaidBlockCollapsed(block, 20)).toBe(false)
    expect(isMermaidBlockCollapsed(block, 30)).toBe(false)
  })
})

// --- `MermaidRenderScheduler`: debounce, guard, error and staleness logic,
// fully decoupled from mermaid/DOM via an injected fake render fn ---

describe('MermaidRenderScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces rapid schedule() calls into a single render of the LATEST source', async () => {
    const render = vi.fn(async (_id: string, source: string) => ({ svg: `<svg>${source}</svg>` }))
    const results: MermaidRenderResult[] = []
    const scheduler = new MermaidRenderScheduler(render, (_key, r) => results.push(r))

    scheduler.schedule('a', 'graph TD;A')
    scheduler.schedule('a', 'graph TD;AB')
    scheduler.schedule('a', 'graph TD;ABC')

    expect(render).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)

    expect(render).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledWith('dohc-mermaid-a', 'graph TD;ABC')
    expect(results.at(-1)).toEqual({ status: 'rendered', svg: '<svg>graph TD;ABC</svg>' })
  })

  it('is a no-op when the source is unchanged', async () => {
    const render = vi.fn(async () => ({ svg: '<svg/>' }))
    const scheduler = new MermaidRenderScheduler(render, () => {})
    scheduler.schedule('a', 'same')
    scheduler.schedule('a', 'same')
    await vi.advanceTimersByTimeAsync(400)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('force re-renders even with an unchanged source (theme flip)', async () => {
    const render = vi.fn(async () => ({ svg: '<svg/>' }))
    const scheduler = new MermaidRenderScheduler(render, () => {})
    scheduler.schedule('a', 'same')
    await vi.advanceTimersByTimeAsync(400)
    expect(render).toHaveBeenCalledTimes(1)

    scheduler.schedule('a', 'same', { force: true })
    await vi.advanceTimersByTimeAsync(400)
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('skips render and reports "skipped" over the 10k-char guard', () => {
    const render = vi.fn()
    const results: MermaidRenderResult[] = []
    const scheduler = new MermaidRenderScheduler(render, (_key, r) => results.push(r))

    scheduler.schedule('a', 'a'.repeat(10_001))
    vi.advanceTimersByTime(1_000)

    expect(render).not.toHaveBeenCalled()
    expect(results).toEqual([{ status: 'skipped' }])
  })

  it('reports an "error" result when render rejects, without throwing', async () => {
    const render = vi.fn(async () => {
      throw new Error('Parse error on line 1')
    })
    const results: MermaidRenderResult[] = []
    const scheduler = new MermaidRenderScheduler(render, (_key, r) => results.push(r))

    scheduler.schedule('a', 'graph TD;bad')
    await vi.advanceTimersByTimeAsync(400)

    expect(results.at(-1)).toEqual({ status: 'error', message: 'Parse error on line 1' })
  })

  it('drops a stale render result superseded by a newer edit', async () => {
    let resolveFirst: (value: { svg: string }) => void = () => {}
    const first = new Promise<{ svg: string }>((resolve) => {
      resolveFirst = resolve
    })
    const render = vi
      .fn<MermaidRenderFn>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => ({ svg: '<svg>second</svg>' }))
    const results: MermaidRenderResult[] = []
    const scheduler = new MermaidRenderScheduler(render, (_key, r) => results.push(r))

    scheduler.schedule('a', 'first-source')
    await vi.advanceTimersByTimeAsync(400) // fires the first (still in-flight) render
    scheduler.schedule('a', 'second-source')
    await vi.advanceTimersByTimeAsync(400) // fires + resolves the second render

    resolveFirst({ svg: '<svg>first</svg>' }) // late resolution of the superseded call
    await Promise.resolve()
    await Promise.resolve()

    expect(results.filter((r) => r.status === 'rendered')).toEqual([
      { status: 'rendered', svg: '<svg>second</svg>' },
    ])
  })

  it('dispose() cancels an in-flight debounce for that key', async () => {
    const render = vi.fn(async () => ({ svg: '<svg/>' }))
    const scheduler = new MermaidRenderScheduler(render, () => {})
    scheduler.schedule('a', 'graph TD;A')
    scheduler.dispose('a')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(render).not.toHaveBeenCalled()
  })
})

// --- `renderMermaidDiagram`: the lazy-import wrapper around the real
// `mermaid` package. mermaid can't run in jsdom, so the import is mocked;
// this only checks the wrapper's contract (strict security, render args). ---

vi.mock('mermaid', () => {
  const initialize = vi.fn()
  const render = vi.fn(async (id: string, text: string) => ({ svg: `<svg data-id="${id}">${text.length}</svg>` }))
  return { default: { initialize, render } }
})

describe('renderMermaidDiagram (mocked mermaid import)', () => {
  it('initializes with strict security and renders the given source', async () => {
    const mermaid = (await import('mermaid')).default as unknown as {
      initialize: ReturnType<typeof vi.fn>
      render: ReturnType<typeof vi.fn>
    }

    const { svg } = await renderMermaidDiagram('dohc-mermaid-1', 'graph TD;\nA-->B')

    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' }),
    )
    expect(mermaid.render).toHaveBeenCalledWith('dohc-mermaid-1', 'graph TD;\nA-->B')
    expect(svg).toContain('<svg')
  })
})

// --- integration: a real Editor + jsdom, mirroring calloutChrome.test.ts's
// pattern, with a directly-injected fake render fn (exercises the plugin's
// decoration + async DOM-sync wiring end to end). ---

describe('makeMermaidPreviewPlugin — DOM wiring', () => {
  const editors: Editor[] = []
  const mounts: HTMLElement[] = []

  afterEach(() => {
    vi.useRealTimers()
    while (editors.length) editors.pop()?.destroy()
    while (mounts.length) mounts.pop()?.remove()
  })

  function makeEditor(markdown: string, render: MermaidRenderFn): Editor {
    const element = document.createElement('div')
    document.body.appendChild(element)
    mounts.push(element)
    const mermaidPreview = Extension.create({
      name: 'testMermaidPreview',
      addProseMirrorPlugins() {
        return [makeMermaidPreviewPlugin(render)]
      },
    })
    const editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        ...dohcMarkdownExtensions,
        TaskList,
        TaskItem,
        Markdown.configure({ indentation: { style: 'space', size: 2 } }),
        mermaidPreview,
      ],
      content: markdown,
      contentType: 'markdown',
    })
    editors.push(editor)
    return editor
  }

  function previewContainer(editor: Editor): HTMLElement {
    const el = editor.view.dom.querySelector<HTMLElement>('.dohc-mermaid-preview')
    if (!el) throw new Error('mermaid preview widget not rendered')
    return el
  }

  it('renders the fence text into the diagram canvas after the debounce', async () => {
    vi.useFakeTimers()
    const render = vi.fn(async (_id: string, source: string) => ({ svg: `<svg data-src="${source}"></svg>` }))
    const editor = makeEditor('```mermaid\ngraph TD;\nA-->B\n```', render)

    await vi.advanceTimersByTimeAsync(400)

    expect(render).toHaveBeenCalledWith(expect.stringContaining('dohc-mermaid-'), 'graph TD;\nA-->B')
    const canvas = previewContainer(editor).querySelector('.dohc-mermaid-preview-canvas')
    expect(canvas?.innerHTML).toContain('data-src="graph TD;\nA-->B"')
  })

  it('shows a quiet error strip on parse failure, keeping the code editable', async () => {
    vi.useFakeTimers()
    const render = vi.fn(async () => {
      throw new Error('Parse error on line 1')
    })
    const editor = makeEditor('```mermaid\nnot valid mermaid\n```', render)

    await vi.advanceTimersByTimeAsync(400)

    const container = previewContainer(editor)
    expect(container.classList.contains('dohc-mermaid-preview--error')).toBe(true)
    const status = container.querySelector<HTMLElement>('.dohc-mermaid-preview-status')
    expect(status?.hidden).toBe(false)
    expect(status?.textContent).toContain('Parse error on line 1')
    // The source stays fully editable — a render failure never locks the block.
    expect(editor.isEditable).toBe(true)
  })

  it('skips rendering and shows a quiet notice over the 10k-char guard', async () => {
    vi.useFakeTimers()
    const render = vi.fn(async () => ({ svg: '<svg/>' }))
    const huge = 'graph TD;\n' + 'A-->B;\n'.repeat(2_000)
    const editor = makeEditor('```mermaid\n' + huge + '```', render)

    await vi.advanceTimersByTimeAsync(400)

    expect(render).not.toHaveBeenCalled()
    expect(previewContainer(editor).classList.contains('dohc-mermaid-preview--skipped')).toBe(true)
  })

  it('collapses the source when the cursor is outside the block, and reveals it inside', () => {
    const render = vi.fn(async () => ({ svg: '<svg/>' }))
    const editor = makeEditor('para\n\n```mermaid\ngraph TD;\nA-->B\n```', render)

    const pre = editor.view.dom.querySelector('pre')
    if (!pre) throw new Error('code block not rendered')
    expect(pre.classList.contains('dohc-mermaid-collapsed')).toBe(true)

    let blockPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (blockPos === -1 && (node.type.name === 'codeBlock' || node.type.name === 'code_block')) {
        blockPos = pos
      }
    })
    expect(blockPos).toBeGreaterThanOrEqual(0)

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(blockPos + 1))),
    )

    expect(pre.classList.contains('dohc-mermaid-collapsed')).toBe(false)
  })

  it('clicking the diagram moves the selection back into the source', () => {
    const render = vi.fn(async () => ({ svg: '<svg/>' }))
    const editor = makeEditor('```mermaid\ngraph TD;\nA-->B\n```', render)

    let blockPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (blockPos === -1 && (node.type.name === 'codeBlock' || node.type.name === 'code_block')) {
        blockPos = pos
      }
    })

    previewContainer(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(editor.state.selection.from).toBe(blockPos + 1)
  })
})

describe('MERMAID_STARTER_SNIPPET', () => {
  it('is a minimal, parseable flowchart body', () => {
    expect(MERMAID_STARTER_SNIPPET).toContain('graph TD;')
    expect(MERMAID_STARTER_SNIPPET.length).toBeLessThan(10_000)
  })
})
