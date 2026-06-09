import type { DohcBackendClient, WorkspaceFile } from './backendClient'

export type ConvexBackendClientTransport = {
  listAtomFiles(): Promise<WorkspaceFile[]>
  listAssetFiles(): Promise<WorkspaceFile[]>
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

export function createConvexBackendClient(
  transport: ConvexBackendClientTransport,
): DohcBackendClient {
  return {
    async listFiles() {
      const [atomFiles, assetFiles] = await Promise.all([
        transport.listAtomFiles(),
        transport.listAssetFiles(),
      ])
      return [...atomFiles, ...assetFiles].sort((a, b) =>
        a.path.localeCompare(b.path),
      )
    },
    readText: (path) => transport.readText(path),
    createTextFile: (input) => transport.createTextFile(input),
    uploadFile: (input) => transport.uploadFile(input),
    renameFile: (input) => transport.renameFile(input),
  }
}
