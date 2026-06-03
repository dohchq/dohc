// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getFunctionName } from 'convex/server'
import { useQuery } from 'convex/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomView } from '../components/AtomView'
import { HtmlAtomFrame } from '../components/HtmlAtomFrame'
import type { FileRow } from '../lib/path-tree'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

vi.mock('convex/react', () => ({
  useMutation: () => vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock('@workos/authkit-tanstack-react-start/client', () => ({
  useAuth: () => ({ user: { id: 'user_1', email: 'ice@example.test' } }),
}))

vi.mock('../lib/active-workspace', () => ({
  useActiveWorkspaceId: () => 'ws_test',
}))

vi.mock('../components/AtomEditor', async () => {
  const React = await import('react')
  return {
    OPEN_SKETCH_EVENT: 'dohc:test-open-sketch',
    AtomEditor: React.forwardRef(function MockAtomEditor() {
      return React.createElement('div', { 'data-testid': 'atom-editor' })
    }),
  }
})

const htmlBody = `---
id: home_html
title: home
status: live
---
<main><h1>Home</h1></main>`

const htmlRow = {
  _id: 'atom_1',
  body: htmlBody,
  migrationNotice: null,
}

const filesWithSibling: FileRow[] = [
  {
    _id: 'atom_1',
    path: 'workspace/home.html',
    title: 'Home',
    source: 'user',
  },
  {
    _id: 'atom_2',
    path: 'workspace/child.md',
    title: 'Child',
    source: 'user',
  },
]

const useQueryMock = vi.mocked(useQuery as any)

async function flushReact() {
  await act(async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  })
}

describe('HTML atom layout', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useQueryMock.mockReset()
    useQueryMock.mockImplementation((query: unknown, args: unknown) => {
      if (args === 'skip') return undefined

      const name = getFunctionName(query as never)
      if (name === 'atoms:getByPath') return htmlRow
      if (name === 'atoms:idAdvisory') return null
      if (name === 'auth:whoami') return { workspaceId: 'ws_test' }
      if (name === 'formulaEval:evalFormulas') return []
      return undefined
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders HTML view mode outside the centered document page column', async () => {
    act(() => {
      root.render(
        React.createElement(AtomView, {
          path: 'workspace/home.html',
          files: filesWithSibling,
          onRunAction: vi.fn(),
          onOpenAtom: vi.fn(),
        }),
      )
    })
    await flushReact()

    const shell = container.querySelector<HTMLElement>('.dohc-html-shell')
    expect(shell).not.toBeNull()
    expect(shell?.classList.contains('doc')).toBe(false)
    expect(shell?.classList.contains('doc-editing')).toBe(false)
    expect(shell?.closest('.doc')).toBeNull()
    expect(
      shell?.querySelector('iframe[title="Rendered HTML page"]'),
    ).not.toBeNull()
    expect(shell?.querySelector('.dohc-title-field')).toBeNull()
    expect(shell?.querySelector('.dohc-props')).toBeNull()
    expect(shell?.querySelector('.dohc-subpages')).toBeNull()
  })

  it('keeps the full-size HTML iframe unframed unless used as a compact preview', () => {
    act(() => {
      root.render(
        React.createElement(HtmlAtomFrame, {
          atomId: 'home_html',
          body: '<main><h1>Home</h1></main>',
        }),
      )
    })

    const iframe = container.querySelector<HTMLIFrameElement>(
      'iframe[title="Rendered HTML page"]',
    )
    const wrapper = iframe?.parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper?.classList.contains('h-full')).toBe(true)
    expect(wrapper?.classList.contains('border')).toBe(false)
    expect(wrapper?.classList.contains('rounded-md')).toBe(false)

    act(() => {
      root.render(
        React.createElement(HtmlAtomFrame, {
          atomId: 'home_html',
          body: '<main><h1>Home</h1></main>',
          compact: true,
        }),
      )
    })

    const compactIframe = container.querySelector<HTMLIFrameElement>(
      'iframe[title="Rendered HTML page"]',
    )
    const compactWrapper = compactIframe?.parentElement
    expect(compactWrapper).not.toBeNull()
    expect(compactWrapper?.classList.contains('h-[280px]')).toBe(true)
    expect(compactWrapper?.classList.contains('border')).toBe(true)
    expect(compactWrapper?.classList.contains('rounded-md')).toBe(true)
    expect(compactWrapper?.classList.contains('bg-page')).toBe(true)
  })
})
