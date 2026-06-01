type Bridge = (op: string, args: Record<string, unknown>) => Promise<unknown>

export function createDohcClient(bridge: Bridge) {
  return {
    sources: {
      list: (args: { source?: string } = {}) =>
        bridge('dohc.sources.list', args),
    },
    atom: {
      get: (args: { path: string }) => bridge('dohc.atom.get', args),
    },
    fields: {
      query: (args: { source?: string; keys?: string[] } = {}) =>
        bridge('dohc.fields.query', args),
    },
    imports: {
      list: () => bridge('dohc.imports.list', {}),
    },
    exports: {
      list: () => bridge('dohc.exports.list', {}),
    },
    source: {
      open: (args: { path: string }) => bridge('dohc.source.open', args),
    },
    agent: {
      run: (args: { prompt: string; sources?: string[] }) =>
        bridge('dohc.agent.run', args),
    },
    patch: {
      propose: (args: {
        path: string
        summary: string
        patch: Record<string, unknown>
      }) => bridge('dohc.patch.propose', args),
    },
  }
}

export const VIRTUAL_DOHC_SDK = `
import { useEffect, useState } from 'react'

export const dohc = window.dohc

export function useDohcQuery(key, loader) {
  const [state, setState] = useState({
    data: null,
    loading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    setState((current) => ({ ...current, loading: true, error: null }))
    Promise.resolve()
      .then(loader)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: error?.message || 'View query failed.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key])

  return state
}
`
