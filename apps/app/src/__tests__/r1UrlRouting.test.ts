import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ActiveWorkspaceProvider,
  useActiveWorkspace,
} from '../lib/active-workspace'
import { agentThreadIdFromRef, agentThreadPath } from '../lib/agent-thread-urls'
import { viewFromPathname } from '../lib/appViews'
import { pageIdFromRef, pagePath } from '../lib/page-urls'

function WorkspaceHarness() {
  const { activeWorkspaceId } = useActiveWorkspace()
  return React.createElement(
    'span',
    { 'data-active-workspace-id': activeWorkspaceId ?? 'personal' },
    activeWorkspaceId ?? 'personal',
  )
}

const originalWindow = globalThis.window

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
  })
})

describe('canonical URL contract', () => {
  it('builds durable page links with a workspace slug and global page id', () => {
    const href = pagePath({
      workspaceSlug: 'ice',
      _id: 'atom_123',
      title: 'Features',
      path: 'docs/features.md',
    })

    expect(href).toBe('/ice/features-atom_123')
    expect(href).not.toContain('/w/')
    expect(pageIdFromRef('features-atom_123')).toBe('atom_123')
    expect(pageIdFromRef('features')).toBeNull()
    expect(pageIdFromRef('shared')).toBeNull()
  })

  it('builds durable agent-thread links inside the workspace slug', () => {
    const href = agentThreadPath({
      workspaceSlug: 'ice',
      threadId: 'abc123',
      title: 'Planning',
    })

    expect(href).toBe('/ice/agent/planning-thread_abc123')
    expect(href).not.toContain('/w/')
    expect(agentThreadIdFromRef('planning-thread_abc123')).toBe('abc123')
    expect(agentThreadIdFromRef('planning')).toBeNull()
  })

  it('maps primary app surfaces from root-level workspace paths', () => {
    expect(viewFromPathname('/ice/agent')).toBe('agent')
    expect(viewFromPathname('/ice/agent/planning-thread_abc123')).toBe('agent')
    expect(viewFromPathname('/ice/files')).toBe('atom')
    expect(viewFromPathname('/ice/views')).toBe('views')
    expect(viewFromPathname('/ice/v/dashboard')).toBe('views')
    expect(viewFromPathname('/ice/graph')).toBe('graph')
    expect(viewFromPathname('/w/me/files')).toBeNull()
  })
})

describe('active workspace state after URL cleanup', () => {
  it('uses localStorage state instead of deriving workspace identity from the URL', () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (key: string) =>
            key === 'dohc.activeWorkspaceId' ? 'org_123' : null,
          setItem: () => {},
          removeItem: () => {},
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        location: { pathname: '/ice/files' },
      },
      configurable: true,
    })

    const html = renderToStaticMarkup(
      React.createElement(
        ActiveWorkspaceProvider,
        null,
        React.createElement(WorkspaceHarness),
      ),
    )

    expect(html).toContain('data-active-workspace-id="org_123"')
    expect(html).not.toContain('ice')
  })
})
