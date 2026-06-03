import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const GRAPH_VIEW_SOURCE = readFileSync(
  new URL('./GraphView.tsx', import.meta.url),
  'utf8',
)

describe('Graph loading skeleton', () => {
  it('renders a quiet graph canvas instead of generic shimmer blobs', () => {
    expect(GRAPH_VIEW_SOURCE).toContain('role="status"')
    expect(GRAPH_VIEW_SOURCE).toContain('aria-label="Loading graph"')
    expect(GRAPH_VIEW_SOURCE).toContain('data-graph-loading-skeleton="true"')
    expect(GRAPH_VIEW_SOURCE).toContain('data-graph-loading-edge="true"')
    expect(GRAPH_VIEW_SOURCE).toContain('data-graph-loading-node="true"')
    expect(GRAPH_VIEW_SOURCE).not.toContain('<Skeleton')
    expect(GRAPH_VIEW_SOURCE).not.toContain('size-20 rounded-full')
  })
})
