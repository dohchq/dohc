// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextWindowMeter } from './Chat'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function pointerDown(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  })
}

async function hover(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

describe('ContextWindowMeter', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('opens context details in a body portal when clicked', async () => {
    act(() => {
      root.render(
        React.createElement(ContextWindowMeter, {
          messageCount: 6,
          usage: {
            compactAtTokens: 170_000,
            contextWindowTokens: 200_000,
            estimatedTokens: 12_400,
            isEstimate: true,
            percent: 7,
          },
          projectPath: null,
          skillCount: 2,
          commandCount: 3,
        }),
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Context window"]',
    )
    await click(trigger)

    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip).not.toBeNull()
    expect(container.contains(tooltip)).toBe(false)
    expect(tooltip?.className).toContain('fixed')
    expect(tooltip?.textContent).toContain('Context window')
    expect(tooltip?.textContent).toContain('~12k / 170k tokens')
    expect(tooltip?.textContent).toContain('Auto compact')
    expect(tooltip?.textContent).toContain('6 messages loaded')
    expect(tooltip?.textContent).not.toContain('/ 50')
    expect(trigger?.textContent).toContain('7%')
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
  })

  it('does not open context details on hover', async () => {
    act(() => {
      root.render(
        React.createElement(ContextWindowMeter, {
          messageCount: 6,
          usage: {
            compactAtTokens: 170_000,
            contextWindowTokens: 200_000,
            estimatedTokens: 12_400,
            isEstimate: true,
            percent: 7,
          },
          projectPath: null,
          skillCount: 2,
          commandCount: 3,
        }),
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Context window"]',
    )
    await hover(trigger)

    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the clicked-open details when clicking elsewhere', async () => {
    act(() => {
      root.render(
        React.createElement(ContextWindowMeter, {
          messageCount: 6,
          usage: {
            compactAtTokens: 170_000,
            contextWindowTokens: 200_000,
            estimatedTokens: 12_400,
            isEstimate: true,
            percent: 7,
          },
          projectPath: '/workspace',
          skillCount: 2,
          commandCount: 3,
        }),
      )
    })

    const outside = document.createElement('button')
    outside.textContent = 'Outside'
    document.body.appendChild(outside)

    await click(container.querySelector('button[aria-label^="Context window"]'))
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull()

    await pointerDown(outside)
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()

    outside.remove()
  })
})
