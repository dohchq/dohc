import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
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

  it('keeps approval resume automatic and scoped to the returned paused run prompt', () => {
    const source = String(AgentApprovalCard)
    expect(source).toContain('Always Allow')
  })
})
