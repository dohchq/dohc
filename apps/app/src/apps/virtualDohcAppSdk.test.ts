import { describe, expect, it } from 'vitest'
import { createDohcClient, VIRTUAL_DOHC_SDK } from './virtualDohcAppSdk'

describe('virtual @dohc/app SDK', () => {
  it('maps framework-neutral SDK calls to bridge operations', async () => {
    const calls: Array<{ op: string; args: unknown }> = []
    const dohc = createDohcClient(async (op, args) => {
      calls.push({ op, args })
      return { ok: true }
    })

    await dohc.sources.list({ source: '.' })
    await dohc.atom.get({ path: 'tasks.md' })
    await dohc.fields.query({ keys: ['status'] })
    await dohc.imports.list()
    await dohc.exports.list()
    await dohc.source.open({ path: 'tasks.md' })
    await dohc.agent.run({ prompt: 'Draft update.', sources: ['tasks.md'] })
    await dohc.actions.run('incrementDone', { source: 'button' })
    await dohc.collection('transactions').list({ where: { reviewed: false } })
    await dohc.collection('transactions').get('tx_1')
    await dohc.collection('transactions').insert({ amount: 42 })
    await dohc.collection('transactions').update('tx_1', { reviewed: true })
    await dohc.collection('transactions').upsert('tx_1', { amount: 42 })
    await dohc.collection('transactions').delete('tx_1')
    await dohc.doc('finance/ledger.md').get()
    await dohc.doc('finance/ledger.md').set('status', 'open')
    await dohc.doc('finance/ledger.md').append('- row')
    await dohc.doc('finance/ledger.md').replaceText({ find: 'old', with: 'new' })
    await dohc.doc('finance/ledger.md').section('Transactions').append('- tx')
    await dohc.doc('finance/ledger.md').section('Summary').replace('Updated')
    await dohc.database('finance/main.sqlite').tables()
    await dohc.database('finance/main.sqlite').query('select * from transactions where id = ?', ['tx_1'])
    await dohc.database('finance/main.sqlite').table('transactions').list()
    await dohc.database('finance/main.sqlite').table('transactions').update('tx_1', { reviewed: true }, { expectedVersion: 2 })
    await dohc.patch.propose({
      path: 'tasks.md',
      summary: 'Mark done',
      patch: { kind: 'frontmatter', set: { status: 'done' } },
    })

    expect(calls).toEqual([
      { op: 'dohc.sources.list', args: { source: '.' } },
      { op: 'dohc.atom.get', args: { path: 'tasks.md' } },
      { op: 'dohc.fields.query', args: { keys: ['status'] } },
      { op: 'dohc.imports.list', args: {} },
      { op: 'dohc.exports.list', args: {} },
      { op: 'dohc.source.open', args: { path: 'tasks.md' } },
      { op: 'dohc.agent.run', args: { prompt: 'Draft update.', sources: ['tasks.md'] } },
      {
        op: 'dohc.actions.run',
        args: { name: 'incrementDone', input: { source: 'button' } },
      },
      {
        op: 'dohc.collection.list',
        args: { name: 'transactions', query: { where: { reviewed: false } } },
      },
      { op: 'dohc.collection.get', args: { name: 'transactions', id: 'tx_1' } },
      { op: 'dohc.collection.insert', args: { name: 'transactions', record: { amount: 42 } } },
      {
        op: 'dohc.collection.update',
        args: { name: 'transactions', id: 'tx_1', patch: { reviewed: true } },
      },
      {
        op: 'dohc.collection.upsert',
        args: { name: 'transactions', id: 'tx_1', record: { amount: 42 } },
      },
      { op: 'dohc.collection.delete', args: { name: 'transactions', id: 'tx_1' } },
      { op: 'dohc.doc.get', args: { path: 'finance/ledger.md' } },
      { op: 'dohc.doc.set', args: { path: 'finance/ledger.md', key: 'status', value: 'open' } },
      { op: 'dohc.doc.append', args: { path: 'finance/ledger.md', markdown: '- row' } },
      {
        op: 'dohc.doc.replaceText',
        args: { path: 'finance/ledger.md', find: 'old', with: 'new' },
      },
      {
        op: 'dohc.doc.section.append',
        args: { path: 'finance/ledger.md', heading: 'Transactions', markdown: '- tx' },
      },
      {
        op: 'dohc.doc.section.replace',
        args: { path: 'finance/ledger.md', heading: 'Summary', markdown: 'Updated' },
      },
      { op: 'dohc.database.tables', args: { path: 'finance/main.sqlite' } },
      {
        op: 'dohc.database.query',
        args: { path: 'finance/main.sqlite', sql: 'select * from transactions where id = ?', params: ['tx_1'] },
      },
      {
        op: 'dohc.database.table.list',
        args: { path: 'finance/main.sqlite', table: 'transactions' },
      },
      {
        op: 'dohc.database.table.update',
        args: {
          path: 'finance/main.sqlite',
          table: 'transactions',
          id: 'tx_1',
          patch: { reviewed: true },
          expectedVersion: 2,
        },
      },
      {
        op: 'dohc.patch.propose',
        args: {
          path: 'tasks.md',
          summary: 'Mark done',
          patch: { kind: 'frontmatter', set: { status: 'done' } },
        },
      },
    ])
  })

  it('preserves concurrent responses by returning each bridge promise', async () => {
    const dohc = createDohcClient((op, args) =>
      Promise.resolve({ op, args }),
    )

    await expect(Promise.all([
      dohc.atom.get({ path: 'a.md' }),
      dohc.atom.get({ path: 'b.md' }),
    ])).resolves.toEqual([
      { op: 'dohc.atom.get', args: { path: 'a.md' } },
      { op: 'dohc.atom.get', args: { path: 'b.md' } },
    ])
  })

  it('lets bridge errors become normal Error objects', async () => {
    const dohc = createDohcClient(async () => {
      throw new Error('Nope.')
    })

    await expect(dohc.sources.list()).rejects.toThrow('Nope.')
  })

  it('turns host failure envelopes into stable friendly SDK errors', async () => {
    const dohc = createDohcClient(async () => ({
      ok: false,
      code: 'write-not-granted',
      message: 'app is not allowed to write collection "transactions".',
    }))

    await expect(
      dohc.collection('transactions').insert({ amount: 42 }),
    ).rejects.toThrow(
      'dohc.collection("transactions").insert failed: app is not allowed to write collection "transactions".',
    )
  })

  it('unwraps collection read envelopes into app-friendly rows', async () => {
    const dohc = createDohcClient(async (op) => {
      if (op === 'dohc.collection.get') {
        return { ok: true, row: { id: 'tx_1', Merchant: 'Grab' } }
      }
      return { ok: true, rows: [{ id: 'tx_1', Merchant: 'Grab' }] }
    })

    await expect(dohc.collection('transactions').list()).resolves.toEqual([
      { id: 'tx_1', Merchant: 'Grab' },
    ])
    await expect(dohc.collection('transactions').get('tx_1')).resolves.toEqual({
      id: 'tx_1',
      Merchant: 'Grab',
    })
  })

  it('evaluates the virtual module against the runtime window bridge', async () => {
    const dohc = { atom: { get: async () => ({ ok: true }) } }
    const success = evaluateVirtualSdk(dohc)
    const loader = async () => ({ rows: [1] })

    expect(success.exports.dohc).toBe(dohc)
    expect(success.exports.useDohcQuery('sources', loader)).toEqual({
      data: null,
      loading: true,
      error: null,
    })
    expect(success.effectDeps[0]).toEqual(['sources', loader])
    await flushPromises()
    expect(success.states.at(-1)).toEqual({
      data: { rows: [1] },
      loading: false,
      error: null,
    })
  })

  it('reports virtual query loader failures through hook state', async () => {
    const failure = evaluateVirtualSdk({})

    failure.exports.useDohcQuery('broken', async () => {
      throw new Error('No access.')
    })
    await flushPromises()

    expect(failure.states.at(-1)).toEqual({
      data: null,
      loading: false,
      error: 'No access.',
    })
  })

  it('exposes document hooks and aliases through the evaluated SDK', () => {
    const success = evaluateVirtualSdk({
      sources: { list: async () => ({ ok: true, rows: [] }) },
      atom: { get: async () => ({ ok: true, atom: { body: '' } }) },
    })

    expect(typeof success.exports.useDocs).toBe('function')
    expect(typeof success.exports.useCollection).toBe('function')
    expect(typeof success.exports.useDoc).toBe('function')
    expect(typeof success.exports.useDatabase).toBe('function')
    expect(typeof success.exports.useAgentRun).toBe('function')
    expect(success.exports.useDocsGlob).toBe(success.exports.useDocs)
    expect(success.exports.useQuery).toBe(success.exports.useLiveQuery)
  })

  it('matches root docs and direct children for double-star globs', async () => {
    const rootGets: string[] = []
    const root = evaluateVirtualSdk({
      sources: {
        list: async () => ({
          ok: true,
          rows: [
            { path: 'README.md' },
            { path: 'src/index.ts' },
            { path: 'src/nested/util.ts' },
          ],
        }),
      },
      atom: {
        get: async ({ path }: { path: string }) => {
          rootGets.push(path)
          return { ok: true, atom: { body: `# ${path}` } }
        },
      },
    })

    root.exports.useDocs('**/*')
    await flushPromises()

    expect(rootGets).toEqual([
      'README.md',
      'src/index.ts',
      'src/nested/util.ts',
    ])

    const srcGets: string[] = []
    const scoped = evaluateVirtualSdk({
      sources: {
        list: async () => ({
          ok: true,
          rows: [
            { path: 'src/index.ts' },
            { path: 'src/nested/util.ts' },
            { path: 'src/styles.css' },
          ],
        }),
      },
      atom: {
        get: async ({ path }: { path: string }) => {
          srcGets.push(path)
          return { ok: true, atom: { body: `# ${path}` } }
        },
      },
    })

    scoped.exports.useDocs('src/**/*.ts')
    await flushPromises()

    expect(srcGets).toEqual(['src/index.ts', 'src/nested/util.ts'])
  })
})

function evaluateVirtualSdk(dohc: unknown) {
  const exports = {} as {
    dohc?: unknown
    useDocs: (pattern?: string) => unknown[]
    useDocsGlob?: (pattern?: string) => unknown[]
    useLiveQuery?: (query: string) => unknown[]
    useQuery?: (query: string) => unknown[]
    useDohcQuery: (key: string, loader: () => Promise<unknown>) => unknown
    useCollection?: (name: string, query?: Record<string, unknown>) => unknown
    useDoc?: (path: string) => unknown
    useDatabase?: (path: string) => unknown
    useAgentRun?: () => unknown
  }
  const states: unknown[] = []
  const effectDeps: unknown[][] = []
  let stateSlot: unknown

  function useState(initial: unknown) {
    stateSlot = typeof initial === 'function' ? initial() : initial
    states.push(stateSlot)
    return [
      stateSlot,
      (next: unknown) => {
        stateSlot = typeof next === 'function'
          ? (next as (current: unknown) => unknown)(stateSlot)
          : next
        states.push(stateSlot)
      },
    ]
  }

  function useEffect(effect: () => void | (() => void), deps: unknown[]) {
    effectDeps.push(deps)
    effect()
  }

  const moduleSource = VIRTUAL_DOHC_SDK
    .replace("import { useEffect, useState } from 'react'", '')
    .replace('export const dohc = window.dohc', 'const dohc = window.dohc; exports.dohc = dohc')
    .replace(
      'export function useDocs',
      'function useDocs',
    )
    .replace(
      'export const useDocsGlob = useDocs',
      'const useDocsGlob = useDocs',
    )
    .replace(
      'export function useLiveQuery',
      'function useLiveQuery',
    )
    .replace(
      'export const useQuery = useLiveQuery',
      'const useQuery = useLiveQuery',
    )
    .replace(
      'export function useDohcQuery',
      'function useDohcQuery',
    )
    .replace(
      'export function useCollection',
      'function useCollection',
    )
    .replace(
      'export function useDoc',
      'function useDoc',
    )
    .replace(
      'export function useDatabase',
      'function useDatabase',
    )
    .replace(
      'export function useAgentRun',
      'function useAgentRun',
    )
    .replace(/^export /gm, '')
    .concat('\nObject.assign(exports, { useDocs, useDocsGlob, useLiveQuery, useQuery, useDohcQuery, useCollection, useDoc, useDatabase, useAgentRun })')

  new Function('window', 'useEffect', 'useState', 'exports', moduleSource)(
    { dohc },
    useEffect,
    useState,
    exports,
  )

  return { exports, states, effectDeps }
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
