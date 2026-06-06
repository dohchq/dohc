import { describe, expect, it } from 'vitest'
import {
  isAppRpcRequest,
  makeAppRpcError,
  makeAppRpcSuccess,
  parseAppRpcRequest,
} from './sdkProtocol'

describe('app SDK protocol validation', () => {
  it('accepts app-first collection, doc, and database operations', () => {
    const cases = [
      {
        id: 'collection-list',
        op: 'dohc.collection.list',
        args: { name: 'transactions', query: { where: { status: 'open' } } },
      },
      { id: 'collection-get', op: 'dohc.collection.get', args: { name: 'transactions', id: 'tx_1' } },
      {
        id: 'collection-insert',
        op: 'dohc.collection.insert',
        args: { name: 'transactions', record: { amount: 42, reviewed: false } },
      },
      {
        id: 'collection-update',
        op: 'dohc.collection.update',
        args: { name: 'transactions', id: 'tx_1', patch: { reviewed: true }, expectedVersion: 2 },
      },
      {
        id: 'collection-upsert',
        op: 'dohc.collection.upsert',
        args: { name: 'transactions', id: 'tx_1', record: { amount: 42 } },
      },
      { id: 'collection-delete', op: 'dohc.collection.delete', args: { name: 'transactions', id: 'tx_1' } },
      { id: 'doc-get', op: 'dohc.doc.get', args: { path: 'finance/ledger.md' } },
      { id: 'doc-set', op: 'dohc.doc.set', args: { path: 'finance/ledger.md', key: 'status', value: 'open' } },
      { id: 'doc-append', op: 'dohc.doc.append', args: { path: 'finance/ledger.md', markdown: '- new row' } },
      {
        id: 'doc-replace',
        op: 'dohc.doc.replaceText',
        args: { path: 'finance/ledger.md', find: 'old', with: 'new', occurrence: 2 },
      },
      {
        id: 'doc-section-append',
        op: 'dohc.doc.section.append',
        args: { path: 'finance/ledger.md', heading: 'Transactions', markdown: '- row' },
      },
      {
        id: 'doc-section-replace',
        op: 'dohc.doc.section.replace',
        args: { path: 'finance/ledger.md', heading: 'Summary', markdown: 'Updated' },
      },
      { id: 'db-tables', op: 'dohc.database.tables', args: { path: 'finance/main.sqlite' } },
      {
        id: 'db-query',
        op: 'dohc.database.query',
        args: { path: 'finance/main.sqlite', sql: 'select * from transactions where id = ?', params: ['tx_1'] },
      },
    ]

    for (const payload of cases) {
      expect(parseAppRpcRequest(payload)).toEqual(payload)
    }
  })

  it('accepts known read-only operations with plain object args', () => {
    expect(parseAppRpcRequest({
      id: '1',
      op: 'dohc.sources.list',
      args: { source: '.' },
    })).toEqual({
      id: '1',
      op: 'dohc.sources.list',
      args: { source: '.' },
    })

    expect(isAppRpcRequest({
      id: '2',
      op: 'dohc.atom.get',
      args: { path: 'tasks.md' },
    })).toBe(true)
    expect(isAppRpcRequest({
      id: '3',
      op: 'dohc.agent.run',
      args: { prompt: 'Draft an update.', sources: ['tasks.md'] },
    })).toBe(true)
    expect(isAppRpcRequest({
      id: '4',
      op: 'dohc.patch.propose',
      args: {
        path: 'tasks.md',
        summary: 'Mark done',
        patch: { kind: 'frontmatter', set: { status: 'done' } },
      },
    })).toBe(true)
    expect(isAppRpcRequest({
      id: '5',
      op: 'dohc.actions.run',
      args: { name: 'incrementDone', input: { source: 'button' } },
    })).toBe(true)
  })

  it('rejects missing ids, unknown operations, and non-object args', () => {
    expect(parseAppRpcRequest({ op: 'dohc.sources.list', args: {} })).toBeNull()
    expect(parseAppRpcRequest({ id: '1', op: 'dohc.nope', args: {} })).toBeNull()
    expect(parseAppRpcRequest({ id: '1', op: 'dohc.sources.list', args: null })).toBeNull()
  })

  it('rejects invalid operation-specific args before host execution', () => {
    expect(parseAppRpcRequest({
      id: '1',
      op: 'dohc.atom.get',
      args: { path: '   ' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '2',
      op: 'dohc.source.open',
      args: { path: '' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '3',
      op: 'dohc.agent.run',
      args: { prompt: ' ' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '4',
      op: 'dohc.fields.query',
      args: { keys: ['status', 1] },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '5',
      op: 'dohc.imports.list',
      args: { workspaceId: 'ws_other' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '6',
      op: 'dohc.exports.list',
      args: { selector: 'billable' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '7',
      op: 'dohc.sources.list',
      args: { source: '.', activeWorkspaceId: 'ws_other' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '8',
      op: 'dohc.actions.run',
      args: { name: ' ' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '9',
      op: 'dohc.actions.run',
      args: { name: 'incrementDone', input: [] },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '10',
      op: 'dohc.collection.list',
      args: { name: '1transactions' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '11',
      op: 'dohc.doc.get',
      args: { path: '../private.md' },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '12',
      op: 'dohc.database.query',
      args: { path: 'finance/main.sqlite', sql: 42 },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '13',
      op: 'dohc.doc.set',
      args: { path: 'finance/ledger.md', key: 'status', value: { nested: true } },
    })).toBeNull()
    expect(parseAppRpcRequest({
      id: '14',
      op: 'dohc.collection.insert',
      args: { name: 'transactions', record: { bad: undefined } },
    })).toBeNull()
  })

  it('rejects prototype-shaped payloads before they reach Convex calls', () => {
    const payload = Object.create({ inherited: true })
    payload.id = '1'
    payload.op = 'dohc.sources.list'
    payload.args = {}
    expect(parseAppRpcRequest(payload)).toBeNull()

    const args = Object.create({ source: '../secret.md' })
    expect(parseAppRpcRequest({
      id: '1',
      op: 'dohc.sources.list',
      args,
    })).toBeNull()

    const record = Object.create({ inherited: true })
    record.amount = 1
    expect(parseAppRpcRequest({
      id: '2',
      op: 'dohc.collection.insert',
      args: { name: 'transactions', record },
    })).toBeNull()
  })

  it('normalizes response envelopes', () => {
    expect(makeAppRpcSuccess('a', { ok: true })).toEqual({
      id: 'a',
      ok: true,
      value: { ok: true },
    })
    expect(makeAppRpcError('b', 'bad-request', 'Bad request.')).toEqual({
      id: 'b',
      ok: false,
      error: {
        code: 'bad-request',
        message: 'Bad request.',
      },
    })
  })
})
