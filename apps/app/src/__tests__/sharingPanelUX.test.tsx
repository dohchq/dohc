import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useMutation, useQuery } from 'convex/react'
import { getFunctionName } from 'convex/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportsExportsPanel } from '../components/SharingPanel'

vi.mock('convex/react', () => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}))

const useQueryMock = vi.mocked(useQuery as any)
const useMutationMock = vi.mocked(useMutation as any)

beforeEach(() => {
  useQueryMock.mockReset()
  useMutationMock.mockReset()
  useMutationMock.mockReturnValue(vi.fn())
})

function renderPanel(queryData: Record<string, unknown>) {
  const values = Object.values(queryData)
  let index = 0
  useQueryMock.mockImplementation((ref: unknown) => {
    const name = getFunctionName(ref as never)
    if (name in queryData) return queryData[name]
    return values[index++]
  })

  return renderToStaticMarkup(
    createElement(ImportsExportsPanel, { onAskDohc: () => {} }),
  )
}

describe('imports/exports panel UX', () => {
  it('frames the empty state around sending and receiving fields', () => {
    const html = renderPanel({
      'windows.consentOverview': [],
      'windows.windowsSharedWithMe': [],
      'windows.whoami': 'ws_current',
    })

    expect(html).toContain('Send fields')
    expect(html).toContain('Receive fields')
    expect(html).toContain('My workspace ID')
    expect(html).toContain('Create export')
    expect(html).toContain('Create a field set first')
    expect(html).not.toContain('No exports yet.')
  })

  it('shows export cards as importers, review, and recipient preview sections', () => {
    const html = renderPanel({
      'windows.consentOverview': [
        {
          windowId: 'window_1',
          name: 'Client hours',
          grantees: ['ws_partner'],
          truncated: false,
          entities: [
            {
              ref: 'client/acme',
              type: 'client',
              slug: 'acme',
              keys: ['hours'],
            },
          ],
          atoms: [{ kind: 'atom', ref: 'logs/2026-06-04.md', key: 'billable' }],
        },
      ],
      'windows.windowsSharedWithMe': [],
      'windows.whoami': 'ws_current',
    })

    expect(html).toContain('Who can import')
    expect(html).toContain('Grant access')
    expect(html).toContain('Review waiting values')
    expect(html).toContain('Export 2 values')
    expect(html).toContain('Recipient preview')
    expect(html).not.toContain('paste importer workspace id…')
  })
})
