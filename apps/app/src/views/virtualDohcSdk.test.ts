import { describe, expect, it } from 'vitest'
import { createDohcClient, VIRTUAL_DOHC_SDK } from './virtualDohcSdk'

describe('virtual @dohc/view SDK', () => {
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
    .replace(/^export /gm, '')
    .concat('\nObject.assign(exports, { useDocs, useDocsGlob, useLiveQuery, useQuery, useDohcQuery })')

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
