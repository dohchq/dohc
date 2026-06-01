// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentModelPicker,
  agentSelectionToConvexArgs,
  type AgentProviderSnapshot,
} from './AgentModelPicker'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const providers: AgentProviderSnapshot[] = [
  {
    providerId: 'openai',
    displayName: 'OpenAI',
    accentColor: '#0f172a',
    status: 'ready',
    missingEnvVar: null,
    defaultModel: 'gpt-5.5',
    defaultReasoningEffort: 'xhigh',
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        contextWindowTokens: 272_000,
        maxContextWindowTokens: 272_000,
        supportsReasoning: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        recommended: true,
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        contextWindowTokens: 272_000,
        maxContextWindowTokens: 1_000_000,
        supportsReasoning: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
    ],
  },
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    accentColor: '#b07a4c',
    status: 'missing_key',
    missingEnvVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-8',
    defaultReasoningEffort: 'high',
    models: [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        contextWindowTokens: 200_000,
        maxContextWindowTokens: 1_000_000,
        supportsReasoning: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        recommended: true,
      },
    ],
  },
]

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

async function keyDown(element: Element | null, key: string) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function findButtonByText(text: string) {
  return (
    Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  )
}

function findModelOptionByText(text: string) {
  return (
    Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
    ).find((button) => button.textContent?.includes(text)) ?? null
  )
}

describe('AgentModelPicker', () => {
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

  it('keeps the picker open after choosing a model so reasoning can still be changed', async () => {
    const onChange = vi.fn()

    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange,
        }),
      )
    })

    await click(container.querySelector('button[aria-label="Choose model"]'))
    await click(findButtonByText('GPT-5.4'))

    expect(onChange).toHaveBeenCalledWith({
      providerId: 'openai',
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
    })
    expect(
      document.body.querySelector('input[placeholder="Search models"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain('Reasoning')
    expect(document.body.textContent).toContain('GPT-5.4')
  })

  it('does not show ready badges for configured providers', async () => {
    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange: vi.fn(),
        }),
      )
    })

    await click(container.querySelector('button[aria-label="Choose model"]'))

    expect(document.body.textContent).toContain('OpenAI')
    expect(document.body.textContent).not.toContain('Ready')
    expect(document.body.textContent).toContain('Set key')
  })

  it('shows per-model context stats in the model list', async () => {
    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange: vi.fn(),
        }),
      )
    })

    await click(container.querySelector('button[aria-label="Choose model"]'))

    expect(document.body.textContent).toContain('272k context')
    expect(document.body.textContent).toContain('up to 1m')
  })

  it('renders provider/model controls without falling back to native selects', async () => {
    const onSetDefault = vi.fn()

    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange: vi.fn(),
          onSetDefault,
        }),
      )
    })

    await click(container.querySelector('button[aria-label="Choose model"]'))

    expect(document.body.textContent).toContain('Provider')
    expect(document.body.textContent).toContain('Reasoning')
    expect(
      document.body.querySelector('input[placeholder="Search models"]'),
    ).not.toBeNull()
    expect(document.body.textContent).toContain('Default')
    expect(document.body.textContent).toContain('Recommended')
    expect(document.body.textContent).toContain('Set key')
    expect(document.body.querySelector('select')).toBeNull()
  })

  it('builds Convex selection args without undefined reasoning fields', () => {
    expect(
      agentSelectionToConvexArgs({
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    ).toEqual({
      agentProviderId: 'anthropic',
      agentModel: 'claude-haiku-4-5',
    })

    expect(
      agentSelectionToConvexArgs({
        providerId: 'openai',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
      }),
    ).toEqual({
      agentProviderId: 'openai',
      agentModel: 'gpt-5.5',
      agentReasoningEffort: 'high',
    })
  })

  it('renders the picker layer in a body portal so fixed positioning uses the viewport', async () => {
    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange: vi.fn(),
        }),
      )
    })

    await click(container.querySelector('button[aria-label="Choose model"]'))

    expect(container.querySelector('input[placeholder="Search models"]')).toBeNull()
    expect(
      document.body.querySelector('input[placeholder="Search models"]'),
    ).not.toBeNull()
  })

  it('anchors the picker frame to the model trigger instead of centering it on the viewport', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })

    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange: vi.fn(),
        }),
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Choose model"]',
    )
    expect(trigger).not.toBeNull()
    trigger!.getBoundingClientRect = () =>
      ({
        x: 24,
        y: 720,
        left: 24,
        top: 720,
        right: 144,
        bottom: 748,
        width: 120,
        height: 28,
        toJSON: () => ({}),
      }) as DOMRect

    await click(trigger)

    const popover = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find(
      (element) => element.getAttribute('style')?.includes('width: 560px'),
    )
    expect(popover?.style.left).toBe('24px')
    expect(popover?.style.bottom).toBe('90px')
  })

  it('closes from document-level outside clicks even when the clicked surface is above the backdrop', async () => {
    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange: vi.fn(),
        }),
      )
    })

    const outsideButton = document.createElement('button')
    outsideButton.textContent = 'Outside layer'
    outsideButton.style.position = 'fixed'
    outsideButton.style.zIndex = '100'
    document.body.appendChild(outsideButton)

    await click(container.querySelector('button[aria-label="Choose model"]'))
    expect(
      document.body.querySelector('input[placeholder="Search models"]'),
    ).not.toBeNull()

    await pointerDown(outsideButton)

    expect(
      document.body.querySelector('input[placeholder="Search models"]'),
    ).toBeNull()

    outsideButton.remove()
  })

  it('supports keyboard navigation, enter selection, escape close, and tab exit', async () => {
    const onChange = vi.fn()

    act(() => {
      root.render(
        React.createElement(AgentModelPicker, {
          providers,
          selection: {
            providerId: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
          },
          onChange,
        }),
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Choose model"]',
    )
    await click(trigger)

    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search models"]',
    )
    expect(document.activeElement).toBe(input)

    await keyDown(input, 'ArrowDown')

    const gpt54 = findModelOptionByText('GPT-5.4')
    expect(gpt54).not.toBeNull()
    expect(gpt54?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(gpt54)

    await keyDown(gpt54, 'ArrowUp')
    const gpt55 = findModelOptionByText('GPT-5.5')
    expect(gpt55?.getAttribute('aria-selected')).toBe('true')

    await keyDown(gpt55, 'ArrowDown')
    await keyDown(findModelOptionByText('GPT-5.4'), 'Enter')
    expect(onChange).toHaveBeenCalledWith({
      providerId: 'openai',
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
    })

    await keyDown(findModelOptionByText('GPT-5.4'), 'Escape')
    expect(
      document.body.querySelector('input[placeholder="Search models"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await click(trigger)
    const reopenedInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search models"]',
    )
    await keyDown(reopenedInput, 'Tab')
    expect(
      document.body.querySelector('input[placeholder="Search models"]'),
    ).toBeNull()
    expect(document.activeElement).not.toBe(reopenedInput)
  })
})
