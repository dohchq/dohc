// Kernels are built-in React renderers (fixed set: heatmap, kanban, cards).
// Plugins are user-authored atoms that bind a kernel to a query pattern
// and supply kernel-specific config. The renderer scans plugin atoms,
// finds one whose `handles` matches the current query, and renders with
// the corresponding kernel.

import type { ComponentType } from 'react'

export type ParsedQueryLite = {
  namespace: string
  verb: string
  resource: string
  filters: Record<string, unknown>
}

// A command declared by a plugin. Selecting it (via palette or shortcut)
// pushes its `prompt` into the chat — agent handles the rest.
export type PluginCommand = {
  id: string
  title: string
  prompt: string
  keybind?: string  // e.g. "cmd+shift+t" — informational for v0
}

// A plugin instance, parsed from a plugin atom in plugins/.
export type PluginInstance = {
  id: string
  name: string
  description: string
  // Query pattern to match. Either `namespace.verb` (matches all
  // queries of that shape) or `namespace.verb("resource")` (exact).
  // Optional — a plugin can register commands without
  // handling any query.
  handles: string
  // Key into the KERNELS registry. Optional for the same reason.
  kernel: string
  // Kernel-specific configuration (groupBy, columns, cardTitle, etc.)
  config: Record<string, unknown>
  // Path to the plugin atom, for "edit" links.
  path: string
  // The atom body AFTER the closing frontmatter ---. Custom kernels use
  // this as their iframe srcDoc; other kernels typically ignore it.
  body: string
  // Registered surfaces.
  commands: PluginCommand[]
  // If true, this plugin renders a global overlay at the top of every
  // atom (in addition to / instead of claiming a query).
  overlay: boolean
}

export type KernelProps = {
  plugin: PluginInstance
  query: ParsedQueryLite
}

export type Kernel = ComponentType<KernelProps>
