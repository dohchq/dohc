// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudApi } from './cloudApi'
import { SignInForm } from './SignInForm'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SignInForm (Better Auth email+password)', () => {
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

  it('posts credentials to /api/auth/sign-in/email with cookie credentials', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({}),
    )
    const api = createCloudApi({ env: { VITE_DOHC_CLOUD_URL: '' }, fetch: fetchImpl })
    const onSignedIn = vi.fn()

    act(() => {
      root.render(<SignInForm api={api} onSignedIn={onSignedIn} />)
    })
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-email"]')!,
      'ada@example.com',
    )
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-password"]')!,
      'hunter22',
    )
    await act(async () => {
      container
        .querySelector('[data-testid="sign-in-form"]')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/sign-in/email',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))
    expect(body).toEqual({ email: 'ada@example.com', password: 'hunter22' })
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('switches to sign-up and posts to /api/auth/sign-up/email', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({}),
    )
    const api = createCloudApi({ env: { VITE_DOHC_CLOUD_URL: '' }, fetch: fetchImpl })
    const onSignedIn = vi.fn()

    act(() => {
      root.render(<SignInForm api={api} onSignedIn={onSignedIn} />)
    })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sign-in-mode-toggle"]')!
        .click()
    })
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-email"]')!,
      'ada@example.com',
    )
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-password"]')!,
      'hunter22',
    )
    await act(async () => {
      container
        .querySelector('[data-testid="sign-in-form"]')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/sign-up/email',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))
    expect(body).toEqual({
      email: 'ada@example.com',
      password: 'hunter22',
      name: 'ada@example.com',
    })
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed sign-in instead of silently swallowing it', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    const api = createCloudApi({ env: { VITE_DOHC_CLOUD_URL: '' }, fetch: fetchImpl })
    const onSignedIn = vi.fn()

    act(() => {
      root.render(<SignInForm api={api} onSignedIn={onSignedIn} />)
    })
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-email"]')!,
      'ada@example.com',
    )
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-password"]')!,
      'wrong',
    )
    await act(async () => {
      container
        .querySelector('[data-testid="sign-in-form"]')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSignedIn).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Sign-in failed/)
  })

  it('clears stale errors when switching sign-in modes', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    const api = createCloudApi({ env: { VITE_DOHC_CLOUD_URL: '' }, fetch: fetchImpl })

    act(() => {
      root.render(<SignInForm api={api} onSignedIn={vi.fn()} />)
    })
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-email"]')!,
      'ada@example.com',
    )
    setValue(
      container.querySelector<HTMLInputElement>('[data-testid="sign-in-password"]')!,
      'wrong',
    )
    await act(async () => {
      container
        .querySelector('[data-testid="sign-in-form"]')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sign-in-mode-toggle"]')!
        .click()
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
