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
  reconcileMermaidEntries,
  renderMermaidDiagram,
  type MermaidRenderFn,
  type MermaidRenderResult,
  type MermaidWidgetEntry,
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

// --- `reconcileMermaidEntries`: the pure identity layer. A fence that only
// shifts position (an edit above it) must keep its id — that's what lets
// ProseMirror preserve the painted widget DOM instead of reminting an empty
// canvas — while genuinely new/removed fences change the id set. ---

describe('reconcileMermaidEntries', () => {
  const entry = (id: string, pos: number, text = 'graph TD;A'): MermaidWidgetEntry => ({
    id,
    pos,
    end: pos + text.length + 2,
    text,
  })
  const blockAt = (pos: number, text = 'graph TD;A') => ({ pos, end: pos + text.length + 2, text })

  it('keeps a fence id stable when an edit above merely shifts its position', () => {
    const previous = [entry('m0', 4)]
    // Three characters typed above the fence: block.pos 4 -> 7, mapped +3.
    const blocks = [blockAt(7)]
    const next = reconcileMermaidEntries(previous, blocks, (p) => p + 3, () => 'MINTED')
    expect(next).toEqual([{ id: 'm0', pos: 7, end: 7 + 'graph TD;A'.length + 2, text: 'graph TD;A' }])
  })

  it('keeps the id (not the text) stable when the fence body itself changes', () => {
    const previous = [entry('m0', 4, 'graph TD;A')]
    // Editing inside the fence changes text/end but not the block start pos.
    const blocks = [blockAt(4, 'graph TD;AB')]
    const next = reconcileMermaidEntries(previous, blocks, (p) => p, () => 'MINTED')
    expect(next[0].id).toBe('m0')
    expect(next[0].text).toBe('graph TD;AB')
  })

  it('mints a fresh id for a newly-added fence and preserves the existing one', () => {
    const previous = [entry('m0', 4)]
    const blocks = [blockAt(4), blockAt(40)]
    let seq = 1
    const next = reconcileMermaidEntries(previous, blocks, (p) => p, () => `m${seq++}`)
    expect(next.map((e) => e.id)).toEqual(['m0', 'm1'])
  })

  it('drops the entry for a deleted fence (its id is no longer active)', () => {
    const previous = [entry('m0', 4), entry('m1', 40)]
    // The second fence was deleted; the first is untouched, so only m0 survives
    // and m1's id falls out of the active set (the plugin prunes its scheduler
    // state).
    const blocks = [blockAt(4)]
    const next = reconcileMermaidEntries(previous, blocks, (p) => p, () => 'MINTED')
    expect(next.map((e) => e.id)).toEqual(['m0'])
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

  it('invalidates an in-flight render when a later edit crosses the size guard', async () => {
    let resolveFirst: (value: { svg: string }) => void = () => {}
    const first = new Promise<{ svg: string }>((resolve) => {
      resolveFirst = resolve
    })
    const render = vi.fn<MermaidRenderFn>().mockImplementationOnce(() => first)
    const results: MermaidRenderResult[] = []
    const scheduler = new MermaidRenderScheduler(render, (_key, r) => results.push(r))

    scheduler.schedule('a', 'graph TD;A')
    await vi.advanceTimersByTimeAsync(400) // the valid render is now in flight
    scheduler.schedule('a', 'a'.repeat(10_001)) // edit crosses the 10k guard → skipped

    resolveFirst({ svg: '<svg>stale</svg>' }) // late resolution of the superseded render
    await Promise.resolve()
    await Promise.resolve()

    // The generation bump on skip drops the stale render — it never repaints
    // its SVG over the skipped state, which stays the last word.
    expect(results.filter((r) => r.status === 'rendered')).toEqual([])
    expect(results.at(-1)).toEqual({ status: 'skipped' })
  })

  it('dispose() cancels an in-flight debounce for that key', async () => {
    const render = vi.fn(async () => ({ svg: '<svg/>' }))
    const scheduler = new MermaidRenderScheduler(render, () => {})
    scheduler.schedule('a', 'graph TD;A')
    scheduler.dispose('a')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(render).not.toHaveBeenCalled()
  })

  it('prune() drops state for keys no longer active (deleted fences)', async () => {
    const render = vi.fn(async (_id: string, source: string) => ({ svg: `<svg>${source}</svg>` }))
    const scheduler = new MermaidRenderScheduler(render, () => {})
    scheduler.schedule('m0', 'graph TD;A')
    scheduler.schedule('m1', 'graph TD;B')

    // m0's fence was deleted; only m1 remains active.
    scheduler.prune(new Set(['m1']))
    await vi.advanceTimersByTimeAsync(400)

    // m0's pending debounce was cancelled; only m1 rendered.
    expect(render).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledWith('dohc-mermaid-m1', 'graph TD;B')

    // And m0's lastSource was cleared, so re-adding it re-renders from scratch.
    scheduler.schedule('m0', 'graph TD;A')
    await vi.advanceTimersByTimeAsync(400)
    expect(render).toHaveBeenCalledWith('dohc-mermaid-m0', 'graph TD;A')
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

  it('preserves the painted widget (same DOM, stable identity) across an edit above the fence', async () => {
    vi.useFakeTimers()
    const render = vi.fn(async (_id: string, source: string) => ({ svg: `<svg data-src="${source}"></svg>` }))
    const editor = makeEditor('para\n\n```mermaid\ngraph TD;\nA-->B\n```', render)

    await vi.advanceTimersByTimeAsync(400)

    const widgetBefore = previewContainer(editor)
    expect(widgetBefore.querySelector('.dohc-mermaid-preview-canvas')?.innerHTML).toContain(
      'data-src="graph TD;\nA-->B"',
    )
    const renderCallsAfterPaint = render.mock.calls.length

    // Type a character into the paragraph ABOVE the fence — this shifts the
    // fence's doc position. Pre-fix, the position-derived key changed and PM
    // destroyed the widget, leaving an empty canvas until a re-render.
    editor.view.dispatch(editor.state.tr.insertText('X', 1))

    const widgetAfter = previewContainer(editor)
    // The SAME DOM node survives (identity preserved) …
    expect(widgetAfter).toBe(widgetBefore)
    // … so the painted diagram is still there with no re-render needed.
    expect(widgetAfter.querySelector('.dohc-mermaid-preview-canvas')?.innerHTML).toContain(
      'data-src="graph TD;\nA-->B"',
    )
    await vi.advanceTimersByTimeAsync(400)
    expect(render.mock.calls.length).toBe(renderCallsAfterPaint)
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

  it('clears the previously-rendered diagram when the edited source errors', async () => {
    vi.useFakeTimers()
    const render = vi.fn(async (_id: string, source: string) => {
      if (source.includes('BOOM')) throw new Error('Parse error on line 1')
      return { svg: `<svg data-src="${source}"></svg>` }
    })
    const editor = makeEditor('```mermaid\ngraph TD;\nA-->B\n```', render)

    await vi.advanceTimersByTimeAsync(400)
    const canvas = previewContainer(editor).querySelector('.dohc-mermaid-preview-canvas')
    expect(canvas?.innerHTML).toContain('data-src="graph TD;\nA-->B"')

    // Edit the fence body IN PLACE (same widget identity) into invalid syntax.
    editor.view.dispatch(
      editor.state.tr.insertText('BOOM', 1, editor.state.doc.content.size - 1),
    )
    await vi.advanceTimersByTimeAsync(400)

    const container = previewContainer(editor)
    expect(container.classList.contains('dohc-mermaid-preview--error')).toBe(true)
    // The stale diagram is gone — no outdated SVG lingering beside the error.
    expect(canvas?.innerHTML).toBe('')
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
