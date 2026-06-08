// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as AtomViewModule from '../components/AtomView'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const convexState = vi.hoisted(() => ({
  upsert: vi.fn(),
  editorShouldEmitEmptyBody: false,
  row: {
    _id: 'atom_finance_ledger',
    body: `---
id: finance.ledger
title: Wallet Ledger
---
# Wallet Ledger

Real transaction rows`,
    migrationNotice: null,
  },
}))

vi.mock('convex/react', async () => {
  const { getFunctionName } =
    await vi.importActual<typeof import('convex/server')>('convex/server')
  return {
    useMutation: () => convexState.upsert,
    useQuery: (query: unknown, args: unknown) => {
      if (args === 'skip') return undefined
      const name = getFunctionName(query as never)
      if (name === 'atoms:getByPath') return convexState.row
      if (name === 'atoms:idAdvisory') return null
      if (name === 'auth:whoami') return { workspaceId: 'ws_test' }
      return undefined
    },
  }
})

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
    AtomEditor: React.forwardRef(function MockAtomEditor(
      props: {
        onChange: (next: string) => void
      },
      _ref,
    ) {
      React.useEffect(() => {
        if (convexState.editorShouldEmitEmptyBody) props.onChange('')
      }, [props])
      return React.createElement('div', { 'data-testid': 'atom-editor' })
    }),
  }
})

describe('AtomView content-loss guard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    convexState.upsert.mockReset()
    convexState.editorShouldEmitEmptyBody = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('detects accidental frontmatter-only overwrites of non-empty markdown', () => {
    const wouldErase = (AtomViewModule as any).wouldErasePostFrontmatterContent

    expect(typeof wouldErase).toBe('function')
    expect(
      wouldErase(
        `---
id: finance.ledger
---
# Ledger

Real transaction rows`,
        `---
id: finance.ledger
---`,
      ),
    ).toBe(true)
    expect(
      wouldErase(
        `---
id: finance.ledger
---
# Ledger`,
        `---
id: finance.ledger
---
# Ledger

Updated`,
      ),
    ).toBe(false)
  })

  it('does not autosave an empty collaborative editor emission over real markdown', async () => {
    convexState.editorShouldEmitEmptyBody = true

    await act(async () => {
      root.render(
        React.createElement(AtomViewModule.AtomView, {
          path: 'finance/ledger.md',
          files: [],
          onRunAction: vi.fn(),
          onOpenAtom: vi.fn(),
        }),
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(650)
    })

    expect(convexState.upsert).not.toHaveBeenCalled()
  })
})
