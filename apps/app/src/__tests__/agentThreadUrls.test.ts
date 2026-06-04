import { describe, expect, it } from 'vitest'
import {
  agentThreadIdFromRef,
  agentThreadPath,
  agentThreadRef,
} from '../lib/agent-thread-urls'

describe('pretty agent chat URLs', () => {
  it('builds a cosmetic chat slug plus a durable thread id', () => {
    expect(
      agentThreadRef({
        threadId: 'thread_01ABC',
        title: 'Product roadmap',
        projectPath: null,
      }),
    ).toBe('product-roadmap-thread_thread_01ABC')
    expect(
      agentThreadPath({
        workspaceSlug: 'ice',
        threadId: 'thread_01ABC',
        title: 'Product roadmap',
        projectPath: null,
      }),
    ).toBe('/ice/agent/product-roadmap-thread_thread_01ABC')
  })

  it('keeps dashed thread ids intact when parsing refs', () => {
    expect(agentThreadIdFromRef('research-thread_tA-dohc')).toBe('tA-dohc')
    expect(agentThreadIdFromRef('research-tA-dohc')).toBeNull()
    expect(agentThreadIdFromRef('thread_tA-dohc')).toBeNull()
  })

  it('falls back to project scope or workspace chat titles', () => {
    expect(
      agentThreadRef({
        threadId: 'thread_01ABC',
        title: '',
        projectPath: 'customers/acme',
      }),
    ).toBe('customers-acme-chat-thread_thread_01ABC')
    expect(
      agentThreadRef({
        threadId: 'thread_01ABC',
        title: '',
        projectPath: null,
      }),
    ).toBe('workspace-chat-thread_thread_01ABC')
  })
})
