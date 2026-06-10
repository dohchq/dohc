// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentApprovalCard } from '../components/Chat'

describe('agent approval resume UX', () => {
  it('renders allow, always allow, and deny approval actions', () => {
    const html = renderToStaticMarkup(
      createElement(AgentApprovalCard, {
        approval: {
          _id: 'approval_1',
          createdAt: 1,
          operation: 'delete_atom',
          title: 'Delete old file',
          detail: 'Delete notes/old.md',
          targetPaths: ['notes/old.md'],
        },
        pendingCount: 1,
        responding: false,
        onAnswer: () => undefined,
      }),
    )

    expect(html).toContain('Allow')
    expect(html).toContain('Always Allow')
    expect(html).toContain('Deny')
  })

  it('returns explicit scoped approval decisions for each action', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const calls: Array<[string, string]> = []

    await act(async () => {
      root.render(
        createElement(AgentApprovalCard, {
          approval: {
            _id: 'approval_1',
            createdAt: 1,
            operation: 'delete_atom',
            title: 'Delete old file',
            detail: 'Delete notes/old.md',
            targetPaths: ['notes/old.md'],
          },
          pendingCount: 1,
          responding: false,
          onAnswer: (approvalId, decision) => calls.push([approvalId, decision]),
        }),
      )
    })

    for (const label of ['Deny', 'Always Allow', 'Allow']) {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes(label),
      )
      expect(button).toBeTruthy()
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }

    expect(calls).toEqual([
      ['approval_1', 'deny'],
      ['approval_1', 'always_allow'],
      ['approval_1', 'allow_once'],
    ])

    await act(async () => root.unmount())
    container.remove()
  })
})
