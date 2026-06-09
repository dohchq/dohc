export type BackendMode = 'convex' | 'postgres'

export type WorkspaceFile = {
  _id: string
  path: string
  title?: string | null
  source: string
  kind: 'atom' | 'asset' | 'database'
  contentType: string
  revision?: string
  updatedAt?: number
  type?: 'html' | 'command' | 'skill' | null
  systemLocked?: boolean
  userLocked?: boolean
  starred?: boolean
  icon?: string | null
  fileId?: string | null
}

export type DohcBackendClient = {
  listFiles(): Promise<WorkspaceFile[]>
  readText(path: string): Promise<{ body: string; revision: string }>
  createTextFile(input: {
    path: string
    body: string
    contentType: string
  }): Promise<WorkspaceFile>
  uploadFile(input: { file: File; path: string }): Promise<WorkspaceFile>
  renameFile(input: {
    path: string
    newName: string
    expectedRevision: string
  }): Promise<WorkspaceFile>
}

export type BackendEnv = {
  DOHC_BACKEND?: string
  VITE_DOHC_BACKEND?: string
}

export function resolveDohcBackendMode(env: BackendEnv = runtimeBackendEnv()): BackendMode {
  const raw = env.DOHC_BACKEND ?? env.VITE_DOHC_BACKEND ?? ''
  const mode = raw.trim().toLowerCase()
  if (mode === '' || mode === 'convex') return 'convex'
  if (mode === 'postgres') return 'postgres'
  throw new Error(`Invalid DOHC_BACKEND value: ${raw}`)
}

export function createDohcBackendClient({
  env,
  convex,
  postgres,
}: {
  env?: BackendEnv
  convex: DohcBackendClient
  postgres: DohcBackendClient
}): DohcBackendClient {
  return resolveDohcBackendMode(env) === 'postgres' ? postgres : convex
}

function runtimeBackendEnv(): BackendEnv {
  const viteEnv =
    (import.meta as unknown as { env?: BackendEnv }).env ?? {}
  const processEnv =
    (globalThis as typeof globalThis & {
      process?: { env?: BackendEnv }
    }).process?.env ?? {}
  return {
    ...processEnv,
    ...viteEnv,
  }
}
