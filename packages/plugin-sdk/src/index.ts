/* @dohc/plugin-sdk — the contract between a dohc custom plugin (running
 * in a sandboxed iframe) and the host app. This is the documented
 * source of truth for the `window.dohc` bridge and the postMessage
 * protocol. The host (CustomKernel) injects a runtime implementation of
 * `window.dohc` into each plugin iframe; these types describe it. */

/** The plugin SDK global. Custom plugins read/write data via `window.dohc`. */
export const DOHC_PLUGIN_GLOBAL = 'dohc' as const

/**
 * postMessage event types exchanged between the host and a plugin
 * iframe. The host and the injected bridge MUST agree on these exact
 * strings — keep this object the single source of truth.
 */
export const PLUGIN_PROTOCOL = {
  /** host → iframe: latest entities/plugin/query snapshot. */
  data: 'dohc:data',
  /** iframe → host: invoke a host method (upsert/patch/delete/fetchEntities). */
  rpc: 'dohc:rpc',
  /** host → iframe: the result of a prior rpc call, keyed by requestId. */
  rpcResult: 'dohc:rpc:result',
  /** iframe → host: report the iframe's content height for auto-resize. */
  resize: 'dohc:resize',
} as const

export type PluginProtocolType =
  (typeof PLUGIN_PROTOCOL)[keyof typeof PLUGIN_PROTOCOL]

/** A stored entity row visible to a plugin. */
export interface PluginEntity {
  type: string
  slug: string
  data: Record<string, unknown>
  [key: string]: unknown
}

/** Result of a write (upsert/patch/delete) routed through the host. */
export interface MutationResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}

/** The snapshot the host pushes to the plugin on every data change. */
export interface PluginData {
  entities: PluginEntity[]
  plugin: { id: string; name: string; config?: Record<string, unknown> }
  query: Record<string, unknown>
}

/**
 * The `window.dohc` API available inside a custom plugin iframe.
 * Mutations are routed to the host over postMessage and are subject to
 * the same Convex authz/safety gates as any other write.
 */
export interface DohcPluginApi {
  /** Latest snapshot, or null until the first `data` message arrives. */
  data: PluginData | null
  /** Subscribe to data changes. Fires immediately if data is present. */
  onUpdate(cb: (data: PluginData) => void): void
  upsert(args: {
    type: string
    slug: string
    data: Record<string, unknown>
  }): Promise<MutationResult>
  patch(args: {
    type: string
    slug: string
    data: Record<string, unknown>
  }): Promise<MutationResult>
  delete(args: { type: string; slug: string }): Promise<MutationResult>
  fetchEntities(type: string): Promise<PluginEntity[]>
}

declare global {
  interface Window {
    dohc: DohcPluginApi
  }
}
