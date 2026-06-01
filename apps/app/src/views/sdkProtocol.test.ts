import { describe, expect, it } from 'vitest'
import {
  isViewRpcRequest,
  makeViewRpcError,
  makeViewRpcSuccess,
  parseViewRpcRequest,
} from './sdkProtocol'

describe('view SDK protocol validation', () => {
  it('accepts known read-only operations with plain object args', () => {
    expect(parseViewRpcRequest({
      id: '1',
      op: 'dohc.sources.list',
      args: { source: '.' },
    })).toEqual({
      id: '1',
      op: 'dohc.sources.list',
      args: { source: '.' },
    })

    expect(isViewRpcRequest({
      id: '2',
      op: 'dohc.atom.get',
      args: { path: 'tasks.md' },
    })).toBe(true)
    expect(isViewRpcRequest({
      id: '3',
      op: 'dohc.agent.run',
      args: { prompt: 'Draft an update.', sources: ['tasks.md'] },
    })).toBe(true)
    expect(isViewRpcRequest({
      id: '4',
      op: 'dohc.patch.propose',
      args: {
        path: 'tasks.md',
        summary: 'Mark done',
        patch: { kind: 'frontmatter', set: { status: 'done' } },
      },
    })).toBe(true)
  })

  it('rejects missing ids, unknown operations, and non-object args', () => {
    expect(parseViewRpcRequest({ op: 'dohc.sources.list', args: {} })).toBeNull()
    expect(parseViewRpcRequest({ id: '1', op: 'dohc.nope', args: {} })).toBeNull()
    expect(parseViewRpcRequest({ id: '1', op: 'dohc.sources.list', args: null })).toBeNull()
  })

  it('rejects prototype-shaped payloads before they reach Convex calls', () => {
    const payload = Object.create({ inherited: true })
    payload.id = '1'
    payload.op = 'dohc.sources.list'
    payload.args = {}
    expect(parseViewRpcRequest(payload)).toBeNull()

    const args = Object.create({ source: '../secret.md' })
    expect(parseViewRpcRequest({
      id: '1',
      op: 'dohc.sources.list',
      args,
    })).toBeNull()
  })

  it('normalizes response envelopes', () => {
    expect(makeViewRpcSuccess('a', { ok: true })).toEqual({
      id: 'a',
      ok: true,
      value: { ok: true },
    })
    expect(makeViewRpcError('b', 'bad-request', 'Bad request.')).toEqual({
      id: 'b',
      ok: false,
      error: {
        code: 'bad-request',
        message: 'Bad request.',
      },
    })
  })
})
