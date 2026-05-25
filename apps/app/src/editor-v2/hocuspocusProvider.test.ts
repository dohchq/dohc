import { describe, expect, it, vi } from 'vitest'
import {
  encodeDohcHocuspocusDocumentName,
  resolveHocuspocusHttpUrl,
  resolveHocuspocusUrl,
  startHocuspocusTokenRefresh,
} from './hocuspocusProvider'

describe('hocuspocus provider adapter', () => {
  it('encodes document names the same way as the service', () => {
    expect(
      encodeDohcHocuspocusDocumentName({
        workspaceId: 'user/ice space',
        atomId: 'atom#1?',
      }),
    ).toBe('workspace/user%2Fice%20space/atom/atom%231%3F')
  })

  it('uses an explicit browser websocket URL when configured', () => {
    expect(
      resolveHocuspocusUrl({
        envUrl: 'wss://sync.example.test',
        locationHref: 'https://app.example.test/a',
      }),
    ).toBe('wss://sync.example.test')
  })

  it('falls back to local hocuspocus only for local dev hosts', () => {
    expect(
      resolveHocuspocusUrl({
        envUrl: '',
        locationHref: 'http://localhost:3000/docs',
      }),
    ).toBe('ws://127.0.0.1:1234')
    expect(
      resolveHocuspocusUrl({
        envUrl: undefined,
        locationHref: 'http://127.0.0.1:3000/docs',
      }),
    ).toBe('ws://127.0.0.1:1234')
  })

  it('does not silently sync production builds to localhost', () => {
    expect(
      resolveHocuspocusUrl({
        envUrl: undefined,
        locationHref: 'https://app.example.test/docs',
      }),
    ).toBeNull()
  })

  it('derives the HTTP capabilities endpoint from the websocket URL', () => {
    expect(resolveHocuspocusHttpUrl('ws://127.0.0.1:1234')).toBe(
      'http://127.0.0.1:1234/capabilities',
    )
    expect(resolveHocuspocusHttpUrl('wss://sync.example.test/ws')).toBe(
      'https://sync.example.test/capabilities',
    )
  })

  it('refreshes provider tokens on an interval and cleans up', () => {
    vi.useFakeTimers()
    const sendToken = vi.fn()
    const cleanup = startHocuspocusTokenRefresh({ sendToken }, 1000)

    vi.advanceTimersByTime(2500)

    expect(sendToken).toHaveBeenCalledTimes(2)
    cleanup()
    vi.advanceTimersByTime(1000)
    expect(sendToken).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
