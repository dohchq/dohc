import { describe, expect, it } from 'vitest'
import { formatChatTimestamp } from './Chat'

describe('formatChatTimestamp', () => {
  it('uses compact same-day times for chat message metadata', () => {
    const value = new Date('2026-06-02T06:15:00Z').getTime()

    expect(formatChatTimestamp(value, {
      now: new Date('2026-06-02T08:00:00Z').getTime(),
      locale: 'en-US',
      timeZone: 'UTC',
    })).toBe('6:15 AM')
  })

  it('includes the date for older chat messages', () => {
    const value = new Date('2026-06-01T23:45:00Z').getTime()

    expect(formatChatTimestamp(value, {
      now: new Date('2026-06-02T08:00:00Z').getTime(),
      locale: 'en-US',
      timeZone: 'UTC',
    })).toBe('Jun 1, 11:45 PM')
  })
})
