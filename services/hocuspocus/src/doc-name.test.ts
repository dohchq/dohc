import { describe, expect, it } from 'vitest'
import { decodeDocName, encodeDocName } from './doc-name.js'

describe('hocuspocus document names', () => {
  it('round-trips workspace and atom identifiers with special characters', () => {
    const input = {
      workspaceId: 'ws/ice main',
      atomId: 'clients.acme:roadmap#v2',
    }

    const encoded = encodeDocName(input)

    expect(encoded).toBe('workspace/ws%2Fice%20main/atom/clients.acme%3Aroadmap%23v2')
    expect(decodeDocName(encoded)).toEqual(input)
  })

  it('rejects malformed document names', () => {
    expect(() => decodeDocName('workspace/ws-only')).toThrow(/Invalid/)
    expect(() => decodeDocName('workspace//atom/x')).toThrow(/Invalid/)
  })
})
