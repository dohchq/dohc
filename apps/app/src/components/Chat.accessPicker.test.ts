// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAccessPicker } from './Chat'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function keyDown(key: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  })
}

describe('AgentAccessPicker', () => {
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

  it('moves focus into the menu and returns it to the trigger on Escape', async () => {
    act(() => {
      root.render(
        React.createElement(AgentAccessPicker, {
          accessMode: 'default',
          disabled: false,
          onChange: vi.fn(),
        }),
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Access permissions"]',
    )
    trigger?.focus()

    await click(trigger)
    await flushAnimationFrame()

    const defaultOption = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Default permissions'),
    )
    expect(document.activeElement).toBe(defaultOption)

    await keyDown('Escape')

    expect(document.body.textContent).not.toContain('Auto-review')
    expect(document.activeElement).toBe(trigger)
  })
})
