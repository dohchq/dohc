import { resolveCloudApiOrigin, type CloudEnv } from '../backend/backendClient'

// dohc Cloud HTTP surface (everything that is not file ops):
//   POST /api/auth/sign-in/email   Better Auth email+password (cookie session)
//   POST /api/auth/sign-up/email
//   GET  /api/auth/get-session     → { user } | null
//   POST /api/auth/sign-out
//   GET  /workspaces               → { workspaces: [{ workspaceId, name? }] }
//   GET  /shared/atoms/:atomId     → { atomId, workspaceId, path, body, capability }
// All calls send credentials so the Better Auth cookie travels.

export type CloudUser = { id: string; email: string; name?: string | null }
export type CloudWorkspace = { workspaceId: string; name?: string | null }
export type SharedAtom = {
  atomId: string
  workspaceId: string
  path: string
  body: string
  capability: 'view' | 'edit'
}

export class CloudApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type CloudApiOptions = {
  env?: CloudEnv
  fetch?: typeof globalThis.fetch
}

export function createCloudApi({ env, fetch: fetchImpl }: CloudApiOptions = {}) {
  const origin = resolveCloudApiOrigin(env)
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis)

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${origin}${path}`, {
      ...init,
      credentials: 'include',
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new CloudApiError(response.status, text || `Request failed: ${response.status}`)
    }
    return (await response.json().catch(() => null)) as T
  }

  return {
    async getSession(): Promise<CloudUser | null> {
      const result = await request<{ user?: CloudUser } | null>('/api/auth/get-session')
      return result?.user ?? null
    },

    async signInWithEmail(input: { email: string; password: string }): Promise<void> {
      await request('/api/auth/sign-in/email', jsonPost(input))
    },

    async signUpWithEmail(input: {
      email: string
      password: string
      name: string
    }): Promise<void> {
      await request('/api/auth/sign-up/email', jsonPost(input))
    },

    async signOut(): Promise<void> {
      await request('/api/auth/sign-out', jsonPost({}))
    },

    async listWorkspaces(): Promise<CloudWorkspace[]> {
      const result = await request<{ workspaces?: CloudWorkspace[] }>('/workspaces')
      return result?.workspaces ?? []
    },

    async getSharedAtom(atomId: string): Promise<SharedAtom> {
      return await request<SharedAtom>(`/shared/atoms/${encodeURIComponent(atomId)}`)
    },
  }
}

export type CloudApi = ReturnType<typeof createCloudApi>

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}
