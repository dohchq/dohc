// The dohc Cloud backend seam. There is ONE backend — the Postgres
// workspace-api — but the client stays behind this contract so the
// shell, tests, and any future transport keep a single seam.

export type WorkspaceFile = {
  id: string
  workspaceId: string
  path: string
  title?: string | null
  kind: 'atom' | 'asset' | 'database'
  contentType: string
  revision: string
  updatedAt: number
}

export type DohcBackendClient = {
  listFiles(): Promise<WorkspaceFile[]>
  readText(path: string): Promise<{ body: string; revision: string }>
  createTextFile(input: {
    path: string
    body: string
    contentType: string
  }): Promise<WorkspaceFile>
  writeText(input: {
    path: string
    body: string
    expectedRevision: string
  }): Promise<WorkspaceFile>
  uploadFile(input: { file: File; path: string }): Promise<WorkspaceFile>
}

export type CloudEnv = {
  VITE_DOHC_CLOUD_URL?: string
}

// API origin for dohc Cloud (workspace-api + Better Auth). Default is
// same-origin ('') — the deployment proxies /workspaces, /shared, and
// /api/auth to the workspace-api service.
export function resolveCloudApiOrigin(env: CloudEnv = runtimeCloudEnv()): string {
  return (env.VITE_DOHC_CLOUD_URL ?? '').trim().replace(/\/+$/g, '')
}

function runtimeCloudEnv(): CloudEnv {
  const viteEnv = (import.meta as unknown as { env?: CloudEnv }).env ?? {}
  const processEnv =
    (globalThis as typeof globalThis & { process?: { env?: CloudEnv } }).process
      ?.env ?? {}
  return { ...processEnv, ...viteEnv }
}
