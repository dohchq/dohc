import { describe, expect, it, vi } from 'vitest'
import { runPendingPromptHandoff } from './Chat'

describe('Chat pending prompt handoff', () => {
  it('keeps a queued prompt while busy, then sends it once when streaming ends', () => {
    let pendingPrompt: string | null = 'queued prompt'
    const submit = vi.fn()
    const onPendingHandled = vi.fn(() => {
      pendingPrompt = null
    })

    expect(
      runPendingPromptHandoff({
        pendingPrompt,
        threadId: 'thread-1',
        canEnsureThread: false,
        sending: false,
        busy: true,
        submit,
        onPendingHandled,
      }),
    ).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    expect(onPendingHandled).not.toHaveBeenCalled()

    expect(
      runPendingPromptHandoff({
        pendingPrompt,
        threadId: 'thread-1',
        canEnsureThread: false,
        sending: false,
        busy: false,
        submit,
        onPendingHandled,
      }),
    ).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('queued prompt')
    expect(onPendingHandled).toHaveBeenCalledTimes(1)

    expect(
      runPendingPromptHandoff({
        pendingPrompt,
        threadId: 'thread-1',
        canEnsureThread: false,
        sending: false,
        busy: false,
        submit,
        onPendingHandled,
      }),
    ).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(onPendingHandled).toHaveBeenCalledTimes(1)
  })
})
