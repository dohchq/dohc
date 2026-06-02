import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AppLoadingScreen,
  SidebarListSkeleton,
  Skeleton,
  SkeletonText,
  ViewFrameSkeleton,
} from './Skeleton'

describe('Skeleton primitives', () => {
  it('renders decorative skeleton shapes without exposing loading copy', () => {
    const html = renderToStaticMarkup(
      createElement(Skeleton, { className: 'h-4 w-24' }),
    )
    const classNames =
      html.match(/class="([^"]+)"/)?.[1]?.split(/\s+/) ?? []

    expect(classNames).toEqual(
      expect.arrayContaining(['dohc-skeleton', 'h-4', 'w-24']),
    )
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('loading')
  })

  it('renders text skeletons as stable multi-line placeholders', () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonText, { lines: 3, className: 'max-w-sm' }),
    )
    const containerClassNames =
      html.match(/^<div class="([^"]+)"/)?.[1]?.split(/\s+/) ?? []
    const skeletonTags =
      html.match(/<div[^>]*class="[^"]*\bdohc-skeleton\b[^"]*"[^>]*>/g) ?? []
    const widthStyles = [...html.matchAll(/style="([^"]*width:\s*\d+%[^"]*)"/g)]

    expect(containerClassNames).toEqual(
      expect.arrayContaining(['max-w-sm', 'space-y-2']),
    )
    expect(skeletonTags).toHaveLength(3)
    expect(
      skeletonTags.every((tag) => tag.includes('aria-hidden="true"')),
    ).toBe(true)
    expect(widthStyles).toHaveLength(3)
  })

  it('renders the app gate as a status region with a full workspace silhouette', () => {
    const html = renderToStaticMarkup(createElement(AppLoadingScreen))

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Loading dohc workspace"')
    expect(html).toContain('grid-cols-[48px_minmax(0,1fr)]')
    expect(html).toContain('sm:grid-cols-[48px_260px_1fr]')
    expect(html).toMatch(/<aside class="[^"]*\bhidden\b[^"]*\bsm:flex\b/)
    expect((html.match(/\bsize-9\b/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((html.match(/dohc-skeleton/g) ?? []).length).toBeGreaterThan(12)
  })

  it('keeps one-section sidebar skeletons inside the native section', () => {
    const html = renderToStaticMarkup(
      createElement(SidebarListSkeleton, { groups: 1, rowsPerGroup: 3 }),
    )

    expect(html).not.toContain('mb-2 h-2 w-20 rounded-full')
    expect((html.match(/\bh-8\b/g) ?? []).length).toBe(3)
  })

  it('renders the view frame skeleton as an embedded runtime surface', () => {
    const html = renderToStaticMarkup(
      createElement(ViewFrameSkeleton, { withHeader: true }),
    )

    expect(html).toContain('h-12')
    expect(html).toContain('absolute inset-0')
    expect(html).not.toContain('place-items-center')
  })

  it('does not wire decorative graph skeleton art into graph view', () => {
    const graphView = readFileSync(
      new URL('./GraphView.tsx', import.meta.url),
      'utf8',
    )
    const skeletonSource = readFileSync(
      new URL('./Skeleton.tsx', import.meta.url),
      'utf8',
    )

    expect(graphView).not.toContain('GraphSkeleton')
    expect(skeletonSource).not.toContain('export function GraphSkeleton')
  })

  it('defines theme-aware shimmer tokens and reduced-motion behavior', () => {
    const css = readFileSync(
      new URL('../styles.css', import.meta.url),
      'utf8',
    )

    expect(css).toContain('--dohc-skeleton-base')
    expect(css).toMatch(
      /\[data-theme='dark'\]\s*\{[\s\S]*--dohc-skeleton-base/,
    )
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*--dohc-skeleton-base/)
    expect(css).toContain('prefers-reduced-motion: reduce')
  })
})
