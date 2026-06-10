import type { DohcBackendClient, WorkspaceFile } from './backendClient'

type PostgresBackendClientOptions = {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

type FileResponse = { file?: WorkspaceFile } & Partial<WorkspaceFile>
type FilesResponse = { files?: WorkspaceFile[] } | WorkspaceFile[]

const DEFAULT_BASE_URL = '/services/workspace-api'

export function createPostgresBackendClient(
  options: PostgresBackendClientOptions = {},
): DohcBackendClient {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL)
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)

  return {
    async listFiles() {
      const result = await requestJson<FilesResponse>(
        fetchImpl,
        `${baseUrl}/files`,
        { credentials: 'include' },
      )
      return Array.isArray(result) ? result : (result.files ?? [])
    },

    async readText(path) {
      return await requestJson<{ body: string; revision: string }>(
        fetchImpl,
        `${baseUrl}/files/text?path=${encodeURIComponent(path)}`,
        { credentials: 'include' },
      )
    },

    async createTextFile(input) {
      const result = await requestJson<FileResponse>(
        fetchImpl,
        `${baseUrl}/files/text`,
        jsonPost(input),
      )
      return unwrapFile(result)
    },

    async uploadFile(input) {
      const form = new FormData()
      form.set('path', input.path)
      form.set('file', input.file)
      const result = await requestJson<FileResponse>(
        fetchImpl,
        `${baseUrl}/files/upload`,
        {
          method: 'POST',
          credentials: 'include',
          body: form,
        },
      )
      return unwrapFile(result)
    },

    async renameFile(input) {
      const result = await requestJson<FileResponse>(
        fetchImpl,
        `${baseUrl}/files/rename`,
        jsonPost(input),
      )
      return unwrapFile(result)
    },
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/g, '')
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

function unwrapFile(result: FileResponse): WorkspaceFile {
  if (result.file) return result.file
  return result as WorkspaceFile
}
