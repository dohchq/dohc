import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NotFoundPage } from '../components/NotFoundPage'

vi.mock('@tanstack/react-router', async () => {
  const React = await import('react')
  return {
    Link: ({
      to,
      children,
      ...props
    }: {
      to: string
      children: React.ReactNode
    }) => React.createElement('a', { href: to, ...props }, children),
  }
})

function renderNotFound() {
  return renderToStaticMarkup(React.createElement(NotFoundPage))
}

function renderWorkspaceNotFound() {
  const WorkspaceNotFoundPage = NotFoundPage as React.ComponentType<{
    mode: 'workspace'
  }>
  return renderToStaticMarkup(
    React.createElement(WorkspaceNotFoundPage, { mode: 'workspace' }),
  )
}

describe('root 404 page', () => {
  it('renders branded 404 actions and copy', () => {
    const html = renderNotFound()

    expect(html).toContain('404')
    expect(html).toContain('This page is not in the workspace.')
    expect(html).toContain('Open workspace')
    expect(html).toContain('Go back')
    expect(html).toContain('missing route')
    expect(html).not.toContain('Sign in')
  })

  it('points the primary action at the workspace root', () => {
    const html = renderNotFound()

    expect(html).toContain('href="/"')
    expect(html).toContain('path unresolved')
    expect(html).toContain('source absent')
  })

  it('can render as an in-workspace panel without taking over the whole viewport', () => {
    const html = renderWorkspaceNotFound()

    expect(html).toContain('This page is not in the workspace.')
    expect(html).toContain('min-h-full')
    expect(html).not.toContain('min-h-screen')
  })
})
