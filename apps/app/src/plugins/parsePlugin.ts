import { parseFrontmatter } from '../lib/frontmatter'
import type { ParsedQueryLite, PluginCommand, PluginInstance } from './types'

// Parses a plugin atom into a PluginInstance. Returns null only when
// the atom is not a plugin (i.e., no `type: plugin` frontmatter).
//
// A plugin atom may declare any combination of:
//   - kernel + handles (renders a query)
//   - commands       (appear in the command palette)
//   - overlay: true  (renders above every atom)
//
// At least one of these has to be present for the plugin to do anything.
export function parsePlugin(path: string, fullBody: string): PluginInstance | null {
  const { meta, body } = parseFrontmatter(fullBody)
  if (meta.type !== 'plugin') return null
  const id = strField(meta, 'id')
  if (!id) return null

  const known = new Set([
    'type',
    'id',
    'name',
    'description',
    'handles',
    'kernel',
    'commands',
    'overlay',
  ])
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (known.has(k)) continue
    config[k] = v
  }

  return {
    id,
    name: strField(meta, 'name') || id,
    description: strField(meta, 'description'),
    handles: strField(meta, 'handles'),
    kernel: strField(meta, 'kernel'),
    config,
    path,
    body,
    commands: parseCommands(meta.commands),
    overlay: meta.overlay === true,
  }
}

function strField(meta: Record<string, unknown>, key: string): string {
  const v = meta[key]
  return typeof v === 'string' ? v : ''
}

function parseCommands(raw: unknown): PluginCommand[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((c): PluginCommand | null => {
      if (!c || typeof c !== 'object') return null
      const obj = c as Record<string, unknown>
      const id = typeof obj.id === 'string' ? obj.id : ''
      const title = typeof obj.title === 'string' ? obj.title : ''
      const prompt = typeof obj.prompt === 'string' ? obj.prompt : ''
      if (!id || !title || !prompt) return null
      return {
        id,
        title,
        prompt,
        keybind: typeof obj.keybind === 'string' ? obj.keybind : undefined,
      }
    })
    .filter((x): x is PluginCommand => x !== null)
}

export function pluginMatches(
  plugin: PluginInstance,
  query: ParsedQueryLite,
): boolean {
  if (!plugin.handles) return false
  const specific = query.resource
    ? `${query.namespace}.${query.verb}("${query.resource}")`
    : null
  const generic = `${query.namespace}.${query.verb}`
  return plugin.handles === specific || plugin.handles === generic
}
