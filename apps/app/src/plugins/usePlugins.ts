import { useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { parsePlugin } from './parsePlugin'
import type { PluginInstance } from './types'

// Returns { plugins, enabled }:
//   plugins — every plugin atom found in plugins/, parsed
//   enabled — set of plugin IDs the user has toggled on
export function usePlugins(): {
  plugins: PluginInstance[]
  enabled: Set<string>
  loading: boolean
} {
  const atoms = useQuery(api.plugins.discover, {})
  const enabledList = useQuery(api.plugins.listEnabled, {})

  const plugins = useMemo(() => {
    if (!atoms) return []
    return atoms
      .map((a: { path: string; body: string }) => parsePlugin(a.path, a.body))
      .filter((p: PluginInstance | null): p is PluginInstance => p !== null)
  }, [atoms])

  return {
    plugins,
    enabled: new Set(enabledList ?? []),
    loading: atoms === undefined || enabledList === undefined,
  }
}
