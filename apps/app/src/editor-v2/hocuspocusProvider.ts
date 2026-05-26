import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'

export type DohcHocuspocusDocument = {
  workspaceId: string
  atomId: string
}

export type CreateDohcHocuspocusProviderOptions = {
  url: string
  documentName: string
  ydoc: Y.Doc
  token: string | (() => string) | (() => Promise<string>)
  awareness?: Awareness | null
  onStatus?: HocuspocusProviderConfiguration['onStatus']
  onSynced?: HocuspocusProviderConfiguration['onSynced']
  onAuthenticated?: HocuspocusProviderConfiguration['onAuthenticated']
  onAuthenticationFailed?: HocuspocusProviderConfiguration['onAuthenticationFailed']
  onAwarenessUpdate?: HocuspocusProviderConfiguration['onAwarenessUpdate']
  onAwarenessChange?: HocuspocusProviderConfiguration['onAwarenessChange']
}

export type DohcHocuspocusCapabilities = {
  atomBootstrap: boolean
}

export type DohcAwarenessUser = {
  id: string
  name?: string | null
  color: string
}

type CreateDohcAwarenessOptions = {
  publish: boolean
  user: DohcAwarenessUser & Record<string, unknown>
}

type RefreshableProvider = Pick<HocuspocusProvider, 'sendToken'>

const LOCAL_HOCUSPOCUS_URL = 'ws://127.0.0.1:1234'
const TOKEN_REFRESH_INTERVAL_MS = 4 * 60 * 1000

export function encodeDohcHocuspocusDocumentName({
  workspaceId,
  atomId,
}: DohcHocuspocusDocument): string {
  return `workspace/${encodeURIComponent(workspaceId)}/atom/${encodeURIComponent(atomId)}`
}

export function resolveHocuspocusUrl(options?: {
  envUrl?: string
  locationHref?: string
}): string | null {
  const explicit = options?.envUrl?.trim()
  if (explicit) return explicit

  const href =
    options?.locationHref ??
    (typeof window === 'undefined' ? undefined : window.location.href)
  if (!href) return null

  const url = new URL(href)
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return LOCAL_HOCUSPOCUS_URL
  }

  return null
}

export function resolveHocuspocusHttpUrl(wsUrl: string): string {
  const url = new URL(wsUrl)
  if (url.protocol === 'ws:') url.protocol = 'http:'
  else if (url.protocol === 'wss:') url.protocol = 'https:'
  url.pathname = '/capabilities'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export async function fetchHocuspocusCapabilities(
  wsUrl: string,
): Promise<DohcHocuspocusCapabilities> {
  const response = await fetch(resolveHocuspocusHttpUrl(wsUrl))
  if (!response.ok) return { atomBootstrap: false }

  const body = (await response.json()) as {
    capabilities?: { atomBootstrap?: unknown }
  }
  return {
    atomBootstrap: body.capabilities?.atomBootstrap === true,
  }
}

export function createDohcAwareness(
  ydoc: Y.Doc,
  { publish, user }: CreateDohcAwarenessOptions,
): Awareness {
  const awareness = new Awareness(ydoc)
  if (!publish) {
    awareness.setLocalState(null)
    return awareness
  }

  awareness.setLocalStateField('user', {
    id: user.id,
    name: user.name?.trim() || 'You',
    color: user.color,
  })
  return awareness
}

export function createDohcHocuspocusProvider({
  url,
  documentName,
  ydoc,
  token,
  awareness,
  onStatus,
  onSynced,
  onAuthenticated,
  onAuthenticationFailed,
  onAwarenessUpdate,
  onAwarenessChange,
}: CreateDohcHocuspocusProviderOptions): HocuspocusProvider {
  return new HocuspocusProvider({
    url,
    name: documentName,
    document: ydoc,
    token,
    awareness: awareness ?? null,
    onStatus,
    onSynced,
    onAuthenticated,
    onAuthenticationFailed,
    onAwarenessUpdate,
    onAwarenessChange,
  })
}

export function startHocuspocusTokenRefresh(
  provider: RefreshableProvider,
  intervalMs = TOKEN_REFRESH_INTERVAL_MS,
): () => void {
  const id = globalThis.setInterval(() => {
    void provider.sendToken()
  }, intervalMs)

  return () => globalThis.clearInterval(id)
}
