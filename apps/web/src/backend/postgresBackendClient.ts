import type { CloudEnv, DohcBackendClient, WorkspaceFile } from './backendClient'
import { resolveCloudApiOrigin } from './backendClient'
import { mediaTypeForPath } from '@dohc/workspace-core'

// HTTP client for services/workspace-api. Routes are workspace-scoped:
//   GET  /workspaces/:id/files                 → { ok, files }
//   GET  /workspaces/:id/files/<path…>         → { ok, file: { …, body, revision } }
//   POST /workspaces/:id/files/<path…>         → create (no expectedRevision) or
//                                                 revision-checked write (with it)
//   POST /workspaces/:id/assets                → { path, kind, mediaType, bytesBase64 }
// Sessions are Better Auth cookies, so every call sends credentials.

type PostgresBackendClientOptions = {
  workspaceId: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

type RawWorkspaceFile = Partial<WorkspaceFile> & { body?: unknown }
type FileResponse = { ok?: boolean; file?: RawWorkspaceFile }
type FilesResponse = { ok?: boolean; files: RawWorkspaceFile[] }

export function createDohcBackendClient({
  workspaceId,
  env,
  fetch,
}: {
  workspaceId: string
  env?: CloudEnv
  fetch?: typeof globalThis.fetch
}): DohcBackendClient {
  return createPostgresBackendClient({
    workspaceId,
    baseUrl: resolveCloudApiOrigin(env),
    fetch,
  })
}

export function createPostgresBackendClient(
  options: PostgresBackendClientOptions,
): DohcBackendClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/g, '')
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const filesUrl = (path?: string) =>
    `${baseUrl}/workspaces/${encodeURIComponent(options.workspaceId)}/files${
      path ? `/${encodeWorkspacePath(path)}` : ''
    }`

  return {
    async listFiles() {
      const result = await requestJson<FilesResponse>(fetchImpl, filesUrl(), {
        credentials: 'include',
      })
      if (!Array.isArray(result.files)) {
        throw new Error('Workspace API returned an invalid files response.')
      }
      return result.files.map((file) => requireWorkspaceFile({ file }, 'listFiles'))
    },

    async readText(path) {
      const result = await requestJson<FileResponse>(fetchImpl, filesUrl(path), {
        credentials: 'include',
      })
      const file = requireWorkspaceFile(result, 'readText')
      if (typeof file.body !== 'string') {
        throw new Error('Workspace API readText response is missing file.body.')
      }
      return { body: file.body, revision: file.revision }
    },

    async createTextFile(input) {
      const result = await requestJson<FileResponse>(
        fetchImpl,
        filesUrl(input.path),
        jsonPost({ body: input.body, kind: atomKindForContentType(input.contentType) }),
      )
      return requireWorkspaceFile(result, 'createTextFile')
    },

    async writeText(input) {
      const result = await requestJson<FileResponse>(
        fetchImpl,
        filesUrl(input.path),
        jsonPost({ body: input.body, expectedRevision: input.expectedRevision }),
      )
      return requireWorkspaceFile(result, 'writeText')
    },

    async uploadFile(input) {
      const mediaType =
        input.file.type ||
        mediaTypeForPath(input.path) ||
        'application/octet-stream'
      const result = await requestJson<FileResponse>(
        fetchImpl,
        `${baseUrl}/workspaces/${encodeURIComponent(options.workspaceId)}/assets`,
        jsonPost({
          path: input.path,
          kind: assetKindForMediaType(mediaType, input.path),
          mediaType,
          bytesBase64: await fileToBase64(input.file),
        }),
      )
      return requireWorkspaceFile(result, 'uploadFile')
    },
  }
}

// Workspace paths keep their `/` separators in the URL; each segment is
// percent-encoded so names with spaces/odd characters round-trip.
function encodeWorkspacePath(path: string) {
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Workspace paths cannot contain empty, ".", or ".." segments.')
  }
  return segments.map(encodeURIComponent).join('/')
}

function requireWorkspaceFile(
  result: FileResponse,
  operation: string,
): WorkspaceFile & { revision: string; body?: string } {
  const file = result.file
  if (!file || typeof file !== 'object') {
    throw new Error(`Workspace API ${operation} response is missing file.`)
  }
  const kind = file.kind
  if (
    typeof file.id !== 'string' ||
    typeof file.workspaceId !== 'string' ||
    typeof file.path !== 'string' ||
    (kind !== 'atom' && kind !== 'asset' && kind !== 'database') ||
    typeof file.contentType !== 'string' ||
    typeof file.updatedAt !== 'number'
  ) {
    throw new Error(`Workspace API ${operation} response contains an invalid file.`)
  }
  if (typeof file.revision !== 'string' || file.revision.length === 0) {
    throw new Error(`Workspace API ${operation} response is missing file.revision.`)
  }
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    path: file.path,
    title: file.title ?? null,
    kind,
    contentType: file.contentType,
    revision: file.revision,
    updatedAt: file.updatedAt,
    ...(typeof file.body === 'string' ? { body: file.body } : {}),
  }
}

function atomKindForContentType(contentType: string) {
  const clean = contentType.toLowerCase()
  if (clean.includes('markdown')) return 'markdown'
  if (clean.includes('csv')) return 'csv'
  if (clean.includes('json')) return 'json'
  if (clean.includes('html')) return 'html'
  return 'text'
}

function assetKindForMediaType(mediaType: string, path: string) {
  const clean = mediaType.toLowerCase()
  if (clean.startsWith('image/')) return 'image'
  if (clean.startsWith('audio/')) return 'audio'
  if (clean.startsWith('video/')) return 'video'
  if (clean === 'application/pdf') return 'pdf'
  if (clean === 'text/csv') return 'csv'
  if (clean === 'application/json') return 'json'
  if (clean.includes('sqlite') || /\.(sqlite|db)$/i.test(path)) return 'sqlite'
  return 'file'
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function requestJson<T>(
  fetchImpl: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(input, init)
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(message || `Workspace API request failed: ${response.status}`)
  }
  return (await response.json()) as T
}
