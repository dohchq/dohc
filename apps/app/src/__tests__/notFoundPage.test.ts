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
})
