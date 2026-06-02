import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AppLoadingScreen,
  Skeleton,
  SkeletonText,
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
    expect((html.match(/dohc-skeleton/g) ?? []).length).toBeGreaterThan(12)
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
